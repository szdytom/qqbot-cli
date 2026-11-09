import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { Service } from "../src/service.ts";
import { Store } from "../src/store.ts";
import { FakeQQ, fixture, incoming, until } from "./helpers.ts";

test("attachments archive asynchronously, enforce streaming limits, and preserve failed metadata", async (t) => {
  const { service, store, config } = await fixture(t);
  let release: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    if (req.url === "/slow")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (req.url === "/oversize") {
      res.writeHead(200);
      res.write("a".repeat(1100));
      res.end();
    } else if (req.url === "/404") {
      res.writeHead(404);
      res.end();
    } else res.end("attachment contents");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        release?.();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  await service.receive({
    ...incoming(),
    attachments: [{ url: `${base}/slow`, name: "../../escape.txt" }],
  });
  await until(() => !!release);
  const initial = store.query().messages[0];
  assert.equal(initial?.attachments[0]?.status, "pending");
  const wait = service.wait({}, 1);
  await service.receive(incoming("text", "text is not blocked"));
  assert.equal((await wait).messages[0]?.text, "text is not blocked");
  release?.();
  await until(() => store.messages.get(initial?.id || "")?.attachments[0]?.status === "ready");
  const attachment = store.messages.get(initial?.id || "")?.attachments[0];
  assert.ok(attachment?.localPath);
  assert.equal(await readFile(attachment.localPath, "utf8"), "attachment contents");
  assert.equal(attachment.localPath, join(config.dataDir, "attachments", attachment.id));
  for (const route of ["oversize", "404"]) {
    await service.receive({ ...incoming(route), attachments: [{ url: `${base}/${route}` }] });
  }
  await until(() =>
    store
      .query()
      .messages.filter((m) => ["oversize", "404"].includes(m.platformId || ""))
      .every((m) => m.attachments[0]?.status === "failed"),
  );
  assert.deepEqual(
    (await readdir(join(config.dataDir, "attachments"))).filter((n) => n.endsWith(".part")),
    [],
  );
});

test("pending attachments recover after restart and attachment updates do not wake message waiters", async (t) => {
  const { service, store, config } = await fixture(t);
  // Stop scheduling new downloads to simulate a crash after the incoming record was committed.
  service.archiver.schedule = () => {};
  const server = createServer((_req, res) => res.end("recovered"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await service.receive({
    ...incoming(),
    attachments: [{ url: `http://127.0.0.1:${address.port}/a` }],
  });
  await service.close();
  const replay = new Store(config.dataDir);
  await replay.load(true);
  const recovered = new Service(replay, config, new FakeQQ());
  const waiting = assert.rejects(recovered.wait({}, 0.05), { code: "WAIT_TIMEOUT" });
  await recovered.recover();
  await until(() => replay.query().messages[0]?.attachments[0]?.status === "ready");
  await waiting;
  assert.equal(store.lastSeq, 1);
  assert.equal(replay.lastSeq, 2);
  await recovered.close();
});
