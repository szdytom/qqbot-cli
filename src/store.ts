import { EventEmitter } from "node:events";
import { mkdir, open, readdir, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { AppError, isErrno } from "./errors.ts";
import type { EventBody, Message, MessageFilter, StoredEvent } from "./types.ts";

export class Store extends EventEmitter {
  readonly dataDir: string;
  readonly messages = new Map<string, Message>();
  private readonly received = new Set<string>();
  lastSeq = 0;
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown;
  private readonly now: () => Date;

  constructor(dataDir: string, now = () => new Date()) {
    super();
    this.dataDir = dataDir;
    this.now = now;
  }

  async load(repair = false): Promise<void> {
    const directory = join(this.dataDir, "events");
    let names: string[];
    try {
      names = (await readdir(directory)).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }
    for (const [index, name] of names.entries()) {
      const path = join(directory, name);
      const content = await readFile(path);
      const completeLength = content.lastIndexOf(10) + 1;
      if (completeLength !== content.length) {
        if (index !== names.length - 1)
          throw new AppError("LOG_CORRUPT", `Incomplete record: ${path}`);
        if (repair) await truncate(path, completeLength);
      }
      for (const [lineNumber, line] of content
        .subarray(0, completeLength)
        .toString("utf8")
        .split("\n")
        .entries()) {
        if (!line) continue;
        try {
          const event = JSON.parse(line) as StoredEvent;
          if (
            event.version !== 1 ||
            !Number.isSafeInteger(event.seq) ||
            event.seq !== this.lastSeq + 1 ||
            typeof event.recordedAt !== "string"
          )
            throw new Error("Invalid version or sequence");
          this.validate(event);
          this.apply(event);
          this.lastSeq = event.seq;
        } catch (error) {
          throw new AppError("LOG_CORRUPT", `Invalid record in ${path}:${lineNumber + 1}`, {
            reason: String(error),
          });
        }
      }
    }
  }

  hasReceived(peerId: string, platformId: string): boolean {
    return this.received.has(JSON.stringify([peerId, platformId]));
  }

  append(body: EventBody): Promise<StoredEvent> {
    const operation = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      const recordedAt = this.now().toISOString();
      const event: StoredEvent = { ...body, version: 1, seq: this.lastSeq + 1, recordedAt };
      this.validate(event);
      // The last file's date never moves backwards when the wall clock is adjusted.
      const day = recordedAt.slice(0, 10);
      const names = await this.logNames();
      const filename = [names.at(-1) || "", `${day}.jsonl`].sort().at(-1) as string;
      const directory = join(this.dataDir, "events");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await open(join(directory, filename), "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.apply(event);
      this.lastSeq = event.seq;
      this.emit("append", event);
      return event;
    });
    this.queue = operation.then(
      () => {},
      (error: unknown) => {
        this.failure = new AppError("PERSISTENCE", "Cannot persist message history", {
          reason: error instanceof Error ? error.message : String(error),
        });
        this.emit("fatal", this.failure);
      },
    );
    return operation;
  }

  private async logNames(): Promise<string[]> {
    try {
      return (await readdir(join(this.dataDir, "events")))
        .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
        .sort();
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
  }

  private apply(event: StoredEvent): void {
    switch (event.kind) {
      case "message.received":
      case "send.started": {
        const m = event.message;
        if (
          !m ||
          typeof m.id !== "string" ||
          typeof m.peerId !== "string" ||
          !Array.isArray(m.attachments)
        ) {
          throw new Error("Invalid message");
        }
        if (this.messages.has(m.id)) throw new Error("Duplicate local message ID");
        this.messages.set(m.id, {
          ...m,
          cursor: event.seq,
          // Text sent before format was introduced always used msg_type 0.
          ...(m.direction === "out" && m.attachments.length === 0
            ? { format: m.format ?? "plain" }
            : {}),
        });
        if (m.direction === "in" && m.platformId) {
          this.received.add(JSON.stringify([m.peerId, m.platformId]));
        }
        break;
      }
      case "send.finished": {
        const message = this.messages.get(event.messageId);
        if (message?.direction !== "out") throw new Error("Unknown outgoing message");
        message.status = event.status;
        message.platformId = event.platformId;
        if (event.timestamp) message.timestamp = event.timestamp;
        message.error = event.error;
        break;
      }
      case "attachment.updated": {
        const message = this.messages.get(event.messageId);
        const index = message?.attachments.findIndex((a) => a.id === event.attachment.id) ?? -1;
        if (!message || index < 0) throw new Error("Unknown attachment");
        message.attachments[index] = event.attachment;
        break;
      }
      default:
        throw new Error("Unknown event kind");
    }
  }

  private validate(event: StoredEvent): void {
    const check = (condition: boolean, message: string) => {
      if (!condition) throw new Error(message);
    };
    const date = (value: unknown) =>
      typeof value === "string" && Number.isFinite(Date.parse(value));
    const attachment = (a: Message["attachments"][number]) => {
      check(
        !!a && typeof a.id === "string" && /^[a-zA-Z0-9_-]+$/.test(a.id),
        "Invalid attachment ID",
      );
      check(["pending", "ready", "failed"].includes(a.status), "Invalid attachment status");
      check(
        a.size === undefined || (Number.isSafeInteger(a.size) && a.size >= 0),
        "Invalid attachment size",
      );
      check(a.url === undefined || typeof a.url === "string", "Invalid attachment URL");
      check(
        a.status !== "ready" || typeof a.localPath === "string",
        "Missing local attachment path",
      );
    };
    switch (event.kind) {
      case "message.received":
      case "send.started": {
        const m = event.message;
        check(
          !!m && typeof m.id === "string" && !!m.id && !this.messages.has(m.id),
          "Invalid or duplicate message ID",
        );
        check(
          typeof m.peerId === "string" && !!m.peerId && typeof m.text === "string",
          "Invalid message content",
        );
        check(date(m.timestamp) && date(m.recordedAt), "Invalid message timestamp");
        check(Array.isArray(m.attachments), "Invalid attachment list");
        check(
          m.format === undefined || m.format === "markdown" || m.format === "plain",
          "Invalid text format",
        );
        for (const a of m.attachments) attachment(a);
        if (event.kind === "message.received") {
          check(
            m.direction === "in" &&
              m.status === "received" &&
              typeof m.platformId === "string" &&
              !!m.platformId,
            "Invalid incoming message",
          );
        } else {
          check(m.direction === "out" && m.status === "pending", "Invalid outgoing message");
          check(
            m.replySeq === undefined || (Number.isSafeInteger(m.replySeq) && m.replySeq > 0),
            "Invalid reply sequence",
          );
        }
        break;
      }
      case "send.finished":
        check(this.messages.get(event.messageId)?.direction === "out", "Unknown outgoing message");
        check(["accepted", "failed", "unknown"].includes(event.status), "Invalid send result");
        check(
          event.status !== "accepted" || typeof event.platformId === "string",
          "Missing QQ message ID",
        );
        check(event.timestamp === undefined || date(event.timestamp), "Invalid result timestamp");
        break;
      case "attachment.updated":
        attachment(event.attachment);
        check(
          this.messages
            .get(event.messageId)
            ?.attachments.some((a) => a.id === event.attachment.id) === true,
          "Unknown attachment",
        );
        break;
      default:
        throw new Error("Unknown event kind");
    }
  }

  query(filter: MessageFilter = {}): { messages: Message[]; cursor: number; hasMore: boolean } {
    if (filter.after !== undefined && filter.after > this.lastSeq) {
      throw new AppError("CURSOR_INVALID", "Cursor is ahead of this history");
    }
    const matching = [...this.messages.values()].filter(
      (m) =>
        (filter.peerId === undefined || m.peerId === filter.peerId) &&
        (filter.direction === undefined || m.direction === filter.direction) &&
        (filter.contains === undefined || m.text.includes(filter.contains)) &&
        (filter.since === undefined || m.timestamp >= filter.since) &&
        (filter.until === undefined || m.timestamp <= filter.until) &&
        (filter.after === undefined || m.cursor > filter.after),
    );
    const limit = filter.limit ?? 50;
    const selected = filter.after === undefined ? matching.slice(-limit) : matching.slice(0, limit);
    return {
      messages: structuredClone(selected),
      cursor: selected.at(-1)?.cursor ?? this.lastSeq,
      hasMore: filter.after !== undefined && matching.length > selected.length,
    };
  }

  peers(): Array<{ peerId: string; lastMessageAt: string; messages: number }> {
    const peers = new Map<string, { peerId: string; lastMessageAt: string; messages: number }>();
    for (const m of this.messages.values()) {
      const peer = peers.get(m.peerId) ?? {
        peerId: m.peerId,
        lastMessageAt: m.timestamp,
        messages: 0,
      };
      if (m.timestamp > peer.lastMessageAt) peer.lastMessageAt = m.timestamp;
      peer.messages++;
      peers.set(m.peerId, peer);
    }
    return [...peers.values()].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.failure) throw this.failure;
  }
}
