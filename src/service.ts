import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { AttachmentArchiver } from "./attachments.ts";
import type { DaemonConfig } from "./config.ts";
import { AppError, errorInfo } from "./errors.ts";
import type { Store } from "./store.ts";
import type {
  InboundMessage,
  Message,
  MessageFilter,
  QQAdapter,
  SendInput,
  StoredEvent,
} from "./types.ts";

export class Service {
  readonly store: Store;
  readonly config: DaemonConfig;
  readonly adapter: QQAdapter;
  readonly controller = new AbortController();
  readonly archiver: AttachmentArchiver;
  connected = false;
  lastReceivedAt?: string;
  lastError?: ReturnType<typeof errorInfo>;
  private receiveQueue: Promise<void> = Promise.resolve();
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(store: Store, config: DaemonConfig, adapter: QQAdapter) {
    this.store = store;
    this.config = config;
    this.adapter = adapter;
    this.archiver = new AttachmentArchiver(store, config, this.controller.signal);
    this.store.on("fatal", (error: unknown) => {
      this.lastError = { code: "PERSISTENCE", message: String(error) };
      this.controller.abort(new AppError("PERSISTENCE", "Cannot persist message history"));
    });
    this.store.setMaxListeners(0); // Independent waiters each subscribe to durable appends.
  }

  async recover(): Promise<void> {
    for (const m of this.store.messages.values()) {
      if (m.direction === "out" && m.status === "pending") {
        await this.store.append({
          kind: "send.finished",
          messageId: m.id,
          status: "unknown",
          error: {
            code: "SEND_UNKNOWN",
            message: "Daemon stopped before recording the send result; not replayed",
          },
        });
      }
      if (m.direction === "in") this.lastReceivedAt = m.recordedAt;
    }
    this.archiver.recover();
  }

  run(): Promise<void> {
    return this.adapter.run(
      {
        onMessage: (m) => this.receive(m),
        onConnection: (connected) => {
          this.connected = connected;
        },
        onError: (error) => {
          this.lastError = errorInfo(error);
          process.stderr.write(`${JSON.stringify({ level: "warn", error: this.lastError })}\n`);
        },
      },
      this.controller.signal,
    );
  }

  receive(input: InboundMessage): Promise<void> {
    const task = this.receiveQueue.then(async () => {
      if (this.controller.signal.aborted || this.store.hasReceived(input.peerId, input.platformId))
        return;
      const now = new Date().toISOString();
      const message: Message = {
        id: randomUUID(),
        cursor: 0,
        direction: "in",
        peerId: input.peerId,
        platformId: input.platformId,
        text: input.text,
        timestamp: input.timestamp,
        recordedAt: now,
        status: "received",
        attachments: (input.attachments || []).map((a) => ({
          ...a,
          id: randomUUID(),
          status: "pending",
        })),
      };
      await this.store.append({ kind: "message.received", message });
      this.lastReceivedAt = now;
      this.archiver.schedule(message.id, message.attachments);
    });
    this.receiveQueue = task.catch(() => {});
    return task;
  }

  send(input: SendInput): Promise<{ message: Message; cursor: number }> {
    const task = this.sendQueue.then(() => this.performSend(input));
    this.sendQueue = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  private selectReply(input: SendInput): Message | undefined {
    if (input.proactive) return undefined;
    const valid = (m: Message) => {
      if (m.direction !== "in" || m.peerId !== input.to || !m.platformId) return false;
      const age = Date.now() - Date.parse(m.timestamp);
      return age >= -60_000 && age < 60 * 60 * 1000 && this.replySequence(m.id) <= 5;
    };
    if (input.replyTo) {
      const m = this.store.messages.get(input.replyTo);
      if (!m || !valid(m))
        throw new AppError(
          "REPLY_UNAVAILABLE",
          "Reply must reference an eligible incoming message for this peer",
        );
      return m;
    }
    return [...this.store.messages.values()].reverse().find(valid);
  }

  private replySequence(id: string): number {
    let sequence = 1;
    for (const m of this.store.messages.values()) {
      if (m.replyTo === id && m.replySeq !== undefined)
        sequence = Math.max(sequence, m.replySeq + 1);
    }
    return sequence;
  }

  private async performSend(input: SendInput): Promise<{ message: Message; cursor: number }> {
    // Commit messages already received by the gateway before selecting a reply target.
    await this.receiveQueue;
    if (this.controller.signal.aborted) throw new AppError("SHUTTING_DOWN", "Daemon is stopping");
    if (!this.connected) throw new AppError("QQ_OFFLINE", "QQ gateway is not connected");
    const cursor = this.store.lastSeq;
    if (input.file) {
      const file = await stat(input.file).catch(() => undefined);
      if (!file?.isFile() || !file.size)
        throw new AppError("FILE_INVALID", "File must be a non-empty regular file");
    }
    const reply = this.selectReply(input);
    const now = new Date().toISOString();
    const message: Message = {
      id: randomUUID(),
      cursor: 0,
      direction: "out",
      peerId: input.to,
      text: input.text ?? input.caption ?? "",
      format: input.file ? undefined : (input.format ?? "markdown"),
      timestamp: now,
      recordedAt: now,
      status: "pending",
      responseCursor: cursor,
      replyTo: reply?.id,
      replySeq: reply ? this.replySequence(reply.id) : undefined,
      attachments: input.file
        ? [
            {
              id: randomUUID(),
              name: basename(input.file),
              status: "ready",
              localPath: input.file,
            },
          ]
        : [],
    };
    await this.store.append({ kind: "send.started", message });
    let dispatched = false;
    try {
      const fileInfo = input.file ? await this.adapter.upload(input.to, input.file) : undefined;
      if (this.controller.signal.aborted)
        throw new AppError("SHUTTING_DOWN", "Daemon stopped before sending");
      dispatched = true;
      const response = await this.adapter.send({
        peerId: input.to,
        text: message.text,
        format: message.format,
        fileInfo,
        replyPlatformId: reply?.platformId,
        replySeq: message.replySeq,
      });
      await this.store.append({
        kind: "send.finished",
        messageId: message.id,
        status: "accepted",
        platformId: response.id,
        timestamp: response.timestamp,
      });
      return { message: structuredClone(this.store.messages.get(message.id) as Message), cursor };
    } catch (error) {
      const unknown = dispatched && (!(error instanceof AppError) || error.code === "SEND_UNKNOWN");
      const info = errorInfo(error);
      await this.store.append({
        kind: "send.finished",
        messageId: message.id,
        status: unknown ? "unknown" : "failed",
        error: info,
      });
      throw new AppError(unknown ? "SEND_UNKNOWN" : info.code, info.message, {
        messageId: message.id,
        cursor,
        status: unknown ? "unknown" : "failed",
        cause: info.details,
      });
    }
  }

  wait(
    filter: MessageFilter,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<{ messages: Message[]; cursor: number }> {
    const after = filter.after ?? this.store.lastSeq;
    if (after > this.store.lastSeq)
      return Promise.reject(new AppError("CURSOR_INVALID", "Cursor is ahead of this history"));
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const cleanup = () => {
        settled = true;
        if (timer) clearTimeout(timer);
        this.store.off("append", onAppend);
        signal?.removeEventListener("abort", onAbort);
        this.controller.signal.removeEventListener("abort", onStop);
      };
      const fail = (error: AppError) => {
        if (!settled) {
          cleanup();
          reject(error);
        }
      };
      const check = () => {
        if (settled) return;
        const found = this.store.query({ ...filter, direction: "in", after, limit: 1 });
        if (found.messages.length) {
          cleanup();
          resolve({ messages: found.messages, cursor: found.cursor });
        }
      };
      const onAppend = (event: StoredEvent) => {
        if (event.kind === "message.received") check();
      };
      const onAbort = () => fail(new AppError("CANCELLED", "Wait cancelled"));
      const onStop = () => fail(new AppError("SHUTTING_DOWN", "Daemon is stopping"));
      this.store.on("append", onAppend);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.controller.signal.addEventListener("abort", onStop, { once: true });
      if (timeoutSeconds > 0) {
        timer = setTimeout(
          () =>
            fail(
              new AppError(
                "WAIT_TIMEOUT",
                "No matching message before timeout",
                { cursor: after },
                3,
              ),
            ),
          timeoutSeconds * 1000,
        );
      }
      if (signal?.aborted) onAbort();
      else if (this.controller.signal.aborted) onStop();
      else check(); // Subscribe and scan in one synchronous turn: no delivery gap.
    });
  }

  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled([this.receiveQueue, this.sendQueue, this.archiver.close()]);
    await this.store.flush();
  }
}
