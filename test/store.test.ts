import assert from "node:assert/strict";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.ts";
import { fixture, incoming } from "./helpers.ts";

test("concurrent input is serialized and duplicate QQ messages are persisted once", async (t) => {
  const { service, store, config } = await fixture(t);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => service.receive(incoming(`in-${i % 10}`, `text ${i}`))),
  );
  assert.equal(store.messages.size, 10);
  assert.equal(store.lastSeq, 10);
  const replay = new Store(config.dataDir);
  await replay.load();
  assert.deepEqual(replay.query(), store.query());
  await service.receive(incoming("in-0"));
  assert.equal(store.lastSeq, 10);
});

test("history filters, pagination, and peers describe recorded messages", async (t) => {
  const { service, store } = await fixture(t);
  for (let i = 0; i < 6; i++)
    await service.receive(incoming(`in-${i}`, `answer ${i}`, i === 1 ? "other" : "self"));
  const first = store.query({ peerId: "self", after: 0, limit: 2 });
  assert.deepEqual(
    first.messages.map((m) => m.text),
    ["answer 0", "answer 2"],
  );
  assert.equal(first.hasMore, true);
  const second = store.query({ peerId: "self", after: first.cursor, limit: 2 });
  assert.deepEqual(
    second.messages.map((m) => m.text),
    ["answer 3", "answer 4"],
  );
  assert.deepEqual(
    store.query({ limit: 2 }).messages.map((m) => m.text),
    ["answer 4", "answer 5"],
  );
  assert.equal(store.query({ contains: "answer 1" }).messages.length, 1);
  assert.equal(store.query({ direction: "out" }).messages.length, 0);
  assert.equal(store.query({ limit: 2 }).hasMore, false);
  assert.throws(() => store.query({ after: 999 }), { code: "CURSOR_INVALID" });
  assert.equal(store.peers().find((p) => p.peerId === "self")?.messages, 5);
});

test("only the final partial record is ignored offline and repaired before append", async (t) => {
  const { service, store, config } = await fixture(t);
  await service.receive(incoming());
  const name = (await readdir(join(config.dataDir, "events")))[0] as string;
  const path = join(config.dataDir, "events", name);
  const before = await readFile(path, "utf8");
  await appendFile(path, '{"version":1,"seq":2');
  const readonly = new Store(config.dataDir);
  await readonly.load();
  assert.equal(readonly.lastSeq, 1);
  assert.notEqual(await readFile(path, "utf8"), before);
  const recovered = new Store(config.dataDir);
  await recovered.load(true);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(recovered.lastSeq, store.lastSeq);
});

test("complete corrupt records fail loudly instead of discarding history", async (t) => {
  const { service, config } = await fixture(t);
  await service.receive(incoming());
  const name = (await readdir(join(config.dataDir, "events")))[0] as string;
  await appendFile(join(config.dataDir, "events", name), "not JSON\n");
  await assert.rejects(new Store(config.dataDir).load(true), { code: "LOG_CORRUPT" });
});

test("daily rotation stays ordered when the wall clock moves backwards", async (t) => {
  const { config } = await fixture(t);
  let time = new Date("2026-11-09T23:59:59Z");
  const store = new Store(config.dataDir, () => time);
  const event = (id: string) => ({
    kind: "message.received" as const,
    message: {
      id,
      cursor: 0,
      direction: "in" as const,
      peerId: "self",
      platformId: id,
      text: id,
      timestamp: time.toISOString(),
      recordedAt: time.toISOString(),
      attachments: [],
      status: "received" as const,
    },
  });
  await store.append(event("a"));
  time = new Date("2026-11-10T00:00:01Z");
  await store.append(event("b"));
  time = new Date("2026-11-09T23:00:00Z");
  await store.append(event("c"));
  assert.equal((await readdir(join(config.dataDir, "events"))).length, 2);
  const replay = new Store(config.dataDir);
  await replay.load();
  assert.deepEqual(
    replay.query().messages.map((m) => m.id),
    ["a", "b", "c"],
  );
});

test("disk errors stop ingestion rather than exposing unpersisted messages", async (t) => {
  const { service, store, config } = await fixture(t);
  await writeFile(join(config.dataDir, "events"), "not a directory");
  await assert.rejects(service.receive(incoming()));
  assert.equal(service.controller.signal.aborted, true);
  assert.equal(store.messages.size, 0);
  await assert.rejects(store.flush());
});

test("partial records in earlier dates are corruption", async (t) => {
  const { config } = await fixture(t);
  await mkdir(join(config.dataDir, "events"));
  await writeFile(join(config.dataDir, "events/2026-11-01.jsonl"), "{");
  await writeFile(join(config.dataDir, "events/2026-11-02.jsonl"), "");
  await assert.rejects(new Store(config.dataDir).load(true), { code: "LOG_CORRUPT" });
});

test("valid JSON with an invalid message shape is treated as corruption", async (t) => {
  const { service, config } = await fixture(t);
  await service.receive(incoming());
  const name = (await readdir(join(config.dataDir, "events")))[0] as string;
  const path = join(config.dataDir, "events", name);
  const event = JSON.parse(await readFile(path, "utf8"));
  event.message.text = 123;
  await writeFile(path, `${JSON.stringify(event)}\n`);
  await assert.rejects(new Store(config.dataDir).load(), { code: "LOG_CORRUPT" });
});

test("replay preserves Markdown/plain and reads pre-upgrade text records as plain", async (t) => {
  const { service, store, config } = await fixture(t);
  const sent = await service.send({ to: "self", text: "# Heading" });
  assert.equal(sent.message.format, "markdown");
  await service.send({ to: "self", text: "**literal**", format: "plain" });
  const legacy = structuredClone(sent.message);
  delete legacy.format;
  legacy.id = "legacy-text";
  legacy.status = "pending";
  await store.append({ kind: "send.started", message: legacy });
  const replay = new Store(config.dataDir);
  await replay.load();
  assert.deepEqual(
    replay.query().messages.map((m) => m.format),
    ["markdown", "plain", "plain"],
  );
});
