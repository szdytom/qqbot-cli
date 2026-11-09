import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonConfig } from "./config.ts";
import type { Store } from "./store.ts";
import type { Attachment } from "./types.ts";

export class AttachmentArchiver {
  private readonly store: Store;
  private readonly config: DaemonConfig;
  private readonly signal: AbortSignal;
  private readonly tasks: Array<{ messageId: string; attachment: Attachment }> = [];
  private readonly active = new Set<Promise<void>>();
  private readonly scheduled = new Set<string>();

  constructor(store: Store, config: DaemonConfig, signal: AbortSignal) {
    this.store = store;
    this.config = config;
    this.signal = signal;
  }

  recover(): void {
    for (const message of this.store.messages.values()) {
      if (message.direction === "in") this.schedule(message.id, message.attachments);
    }
  }

  schedule(messageId: string, attachments: Attachment[]): void {
    for (const attachment of attachments) {
      if (attachment.status === "pending" && !this.scheduled.has(attachment.id)) {
        this.scheduled.add(attachment.id);
        this.tasks.push({ messageId, attachment: { ...attachment } });
      }
    }
    this.pump();
  }

  private pump(): void {
    while (!this.signal.aborted && this.active.size < this.config.attachments.concurrency) {
      const task = this.tasks.shift();
      if (!task) break;
      const promise = this.download(task.messageId, task.attachment)
        .catch(() => {
          // Store emits fatal on write failure; daemon owns shutdown.
        })
        .finally(() => {
          this.active.delete(promise);
          this.scheduled.delete(task.attachment.id);
          this.pump();
        });
      this.active.add(promise);
    }
  }

  private async download(messageId: string, attachment: Attachment): Promise<void> {
    const directory = join(this.config.dataDir, "attachments");
    const destination = join(directory, attachment.id);
    const temporary = `${destination}.part`;
    try {
      if (!attachment.url || !/^https?:\/\//.test(attachment.url))
        throw new Error("Missing HTTP attachment URL");
      if (attachment.size !== undefined && attachment.size > this.config.attachments.maxBytes) {
        throw new Error("Attachment exceeds maxBytes");
      }
      const signal = AbortSignal.any([
        this.signal,
        AbortSignal.timeout(this.config.attachments.timeoutSeconds * 1000),
      ]);
      const response = await fetch(attachment.url, { signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Attachment HTTP ${response.status}`);
      }
      const declaredSize = Number(response.headers.get("content-length"));
      if (declaredSize > this.config.attachments.maxBytes) {
        await response.body.cancel();
        throw new Error("Attachment exceeds maxBytes");
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await open(temporary, "w", 0o600);
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > this.config.attachments.maxBytes)
            throw new Error("Attachment exceeds maxBytes");
          await handle.writeFile(chunk);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
      attachment = {
        ...attachment,
        status: "ready",
        localPath: destination,
        size,
        error: undefined,
      };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (this.signal.aborted) return; // Keep pending so the next daemon can resume.
      attachment = {
        ...attachment,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await this.store.append({ kind: "attachment.updated", messageId, attachment });
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.active);
  }
}
