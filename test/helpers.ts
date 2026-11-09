import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { DaemonConfig } from "../src/config.ts";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import type { AdapterHandlers, InboundMessage, QQAdapter } from "../src/types.ts";

export class FakeQQ implements QQAdapter {
  handlers?: AdapterHandlers;
  sends: Array<Parameters<QQAdapter["send"]>[0]> = [];
  uploads: Array<{ peerId: string; file: string }> = [];
  onSend?: (input: Parameters<QQAdapter["send"]>[0]) => Promise<void>;
  onUpload?: () => Promise<void>;

  async run(handlers: AdapterHandlers, signal: AbortSignal): Promise<void> {
    this.handlers = handlers;
    handlers.onConnection(true);
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    handlers.onConnection(false);
  }

  async send(input: Parameters<QQAdapter["send"]>[0]): ReturnType<QQAdapter["send"]> {
    this.sends.push(input);
    await this.onSend?.(input);
    return { id: `sent-${this.sends.length}` };
  }

  async upload(peerId: string, file: string): Promise<string> {
    this.uploads.push({ peerId, file });
    await this.onUpload?.();
    return "uploaded";
  }

  async incoming(id = "in-1", text = "hello", peerId = "self"): Promise<void> {
    await this.handlers?.onMessage(incoming(id, text, peerId));
  }
}

export function incoming(platformId = "in-1", text = "hello", peerId = "self"): InboundMessage {
  return { platformId, text, peerId, timestamp: new Date().toISOString() };
}

export async function fixture(
  t: TestContext,
): Promise<{ config: DaemonConfig; store: Store; service: Service; adapter: FakeQQ }> {
  const dataDir = await mkdtemp(join(tmpdir(), "qqbot-"));
  const config = testConfig(dataDir);
  const store = new Store(dataDir);
  const adapter = new FakeQQ();
  const service = new Service(store, config, adapter);
  service.connected = true;
  t.after(async () => {
    await service.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });
  return { config, store, service, adapter };
}

export function testConfig(dataDir: string): DaemonConfig {
  return {
    dataDir,
    socketPath: join(dataDir, "daemon.sock"),
    appId: "test",
    appSecret: "secret",
    attachments: { maxBytes: 1024, timeoutSeconds: 1, concurrency: 2 },
  };
}

export async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
