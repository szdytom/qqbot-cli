import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { AppError } from "../src/errors.ts";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { FakeQQ, fixture, incoming } from "./helpers.ts";

test("wait with a cursor catches the reply that arrives before the send returns", async (t) => {
  const { service, adapter } = await fixture(t);
  await service.receive(incoming("initial", "start"));
  adapter.onSend = async () => {
    await service.receive(incoming("reply", "yes"));
  };
  const sent = await service.send({ to: "self", text: "Finished?" });
  const result = await service.wait({ after: sent.cursor, peerId: "self" }, 1);
  assert.equal(result.messages[0]?.text, "yes");
  assert.equal(adapter.sends[0]?.replyPlatformId, "initial");
  assert.equal(adapter.sends[0]?.replySeq, 1);
});

test("send uses an incoming message still being committed when the command arrives", async (t) => {
  const { service, adapter } = await fixture(t);
  await Promise.all([
    service.receive(incoming("arriving", "start")),
    service.send({ to: "self", text: "report" }),
  ]);
  assert.equal(adapter.sends[0]?.replyPlatformId, "arriving");
});

test("independent waiters see the same durable message, with sender and text filters", async (t) => {
  const { service, store } = await fixture(t);
  const first = service.wait({ peerId: "self", contains: "yes" }, 1);
  const second = service.wait({ peerId: "self", contains: "yes" }, 1);
  await service.receive(incoming("other", "yes", "other"));
  await service.receive(incoming("no", "no"));
  await service.receive(incoming("yes", "yes please"));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.messages[0]?.id, b.messages[0]?.id);
  assert.equal(a.messages[0]?.text, "yes please");
  const replay = new Store(store.dataDir);
  await replay.load();
  assert.equal(replay.query({ contains: "please" }).messages[0]?.id, a.messages[0]?.id);
  assert.equal(store.listenerCount("append"), 0);
});

test("wait defaults to future messages, and timeout/cancellation clean up listeners", async (t) => {
  const { service, store } = await fixture(t);
  await service.receive(incoming());
  await assert.rejects(service.wait({}, 0.01), { code: "WAIT_TIMEOUT", exitCode: 3 });
  assert.equal(store.listenerCount("append"), 0);
  const controller = new AbortController();
  const waiting = service.wait({}, 0, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { code: "CANCELLED" });
  await assert.rejects(service.wait({ after: 999 }, 1), { code: "CURSOR_INVALID" });
  assert.equal(store.listenerCount("append"), 0);
});

test("wait closes on daemon shutdown", async (t) => {
  const { service } = await fixture(t);
  const wait = service.wait({}, 0);
  const check = assert.rejects(wait, { code: "SHUTTING_DOWN" });
  await service.close();
  await check;
});

test("graceful shutdown waits for an already dispatched send to be recorded", async (t) => {
  const { service, adapter, store } = await fixture(t);
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  adapter.onSend = async () => {
    started();
    await response;
  };
  const sending = service.send({ to: "self", text: "# Complete" });
  await began;
  let closed = false;
  const closing = service.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  assert.equal((await sending).message.status, "accepted");
  await closing;
  const replay = new Store(store.dataDir);
  await replay.load();
  assert.equal(replay.query().messages[0]?.status, "accepted");
  assert.equal(replay.query().messages[0]?.format, "markdown");
});

test("outgoing messages do not wake waiters", async (t) => {
  const { service } = await fixture(t);
  const result = assert.rejects(service.wait({}, 0.02), { code: "WAIT_TIMEOUT" });
  await service.send({ to: "self", text: "notice" });
  await result;
});

test("reply sequences are serialized and survive a process restart", async (t) => {
  const { service, adapter, config } = await fixture(t);
  await service.receive(incoming());
  await Promise.all([
    service.send({ to: "self", text: "one" }),
    service.send({ to: "self", text: "two" }),
  ]);
  assert.deepEqual(
    adapter.sends.map((s) => s.replySeq),
    [1, 2],
  );
  await service.close();
  const replay = new Store(config.dataDir);
  await replay.load(true);
  const nextAdapter = new FakeQQ();
  const next = new Service(replay, config, nextAdapter);
  next.connected = true;
  await next.recover();
  await next.send({ to: "self", text: "three" });
  assert.equal(nextAdapter.sends[0]?.replySeq, 3);
  await next.close();
});

test("QQ rejection never silently falls back to proactive or resends", async (t) => {
  const { service, adapter, store } = await fixture(t);
  await service.receive(incoming());
  adapter.onSend = async () => {
    throw new AppError("QQ_REJECTED", "permission denied", { qqCode: 123 });
  };
  await assert.rejects(service.send({ to: "self", text: "notice" }), { code: "QQ_REJECTED" });
  assert.equal(adapter.sends.length, 1);
  assert.equal(store.query({ direction: "out" }).messages[0]?.status, "failed");
  assert.equal(adapter.sends[0]?.replyPlatformId, "in-1");
});

test("uncertain sends remain unknown and are never replayed", async (t) => {
  const { service, adapter, store, config } = await fixture(t);
  adapter.onSend = async () => {
    throw new Error("connection reset");
  };
  await assert.rejects(service.send({ to: "self", text: "notice" }), { code: "SEND_UNKNOWN" });
  assert.equal(store.query().messages[0]?.status, "unknown");
  const message = structuredClone(store.query().messages[0]);
  assert.ok(message);
  message.id = "unfinished";
  message.status = "pending";
  await store.append({ kind: "send.started", message });
  await service.close();
  const replay = new Store(config.dataDir);
  await replay.load(true);
  const fake = new FakeQQ();
  const recovered = new Service(replay, config, fake);
  await recovered.recover();
  assert.equal(replay.messages.get("unfinished")?.status, "unknown");
  assert.equal(fake.sends.length, 0);
  await recovered.close();
});

test("explicit proactive, invalid replies, reply budget, and expiry", async (t) => {
  const { service, adapter, store } = await fixture(t);
  await service.receive(incoming());
  const id = store.query().messages[0]?.id;
  await assert.rejects(service.send({ to: "other", text: "wrong", replyTo: id }), {
    code: "REPLY_UNAVAILABLE",
  });
  await service.send({ to: "self", text: "proactive", proactive: true });
  assert.equal(adapter.sends.at(-1)?.replyPlatformId, undefined);
  for (let i = 0; i < 5; i++) await service.send({ to: "self", text: `reply ${i}` });
  await service.send({ to: "self", text: "budget exhausted" });
  assert.equal(adapter.sends.at(-1)?.replyPlatformId, undefined);
  await service.receive({
    ...incoming("old"),
    timestamp: new Date(Date.now() - 3600001).toISOString(),
  });
  await service.send({ to: "self", text: "expired" });
  assert.equal(adapter.sends.at(-1)?.replyPlatformId, undefined);
});

test("file upload is followed by one media send; upload failure is definitively failed", async (t) => {
  const { service, adapter, config, store } = await fixture(t);
  const file = join(config.dataDir, "file.txt");
  await writeFile(file, "contents");
  const result = await service.send({ to: "self", file, caption: "report" });
  assert.equal(adapter.sends[0]?.fileInfo, "uploaded");
  assert.equal(result.message.status, "accepted");
  adapter.onUpload = async () => {
    throw new Error("upload rejected");
  };
  await assert.rejects(service.send({ to: "self", file }));
  assert.equal(adapter.sends.length, 1);
  assert.equal(store.query({ direction: "out" }).messages.at(-1)?.status, "failed");
});
