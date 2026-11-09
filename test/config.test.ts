import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, loadDaemonConfig } from "../src/config.ts";
import { errorInfo } from "../src/errors.ts";
import { parseFilter, parseSend } from "../src/input.ts";
import { fixture } from "./helpers.ts";

test("configuration loads defaults, explicit paths, and environment credentials", async (t) => {
  const { config } = await fixture(t);
  const path = join(config.dataDir, "config.json");
  await writeFile(
    path,
    JSON.stringify({ appId: "file-id", appSecret: "file-secret", defaultPeer: "me" }),
  );
  const previousId = process.env.QQBOT_APP_ID;
  const previousSecret = process.env.QQBOT_APP_SECRET;
  process.env.QQBOT_APP_ID = "environment-id";
  process.env.QQBOT_APP_SECRET = "environment-secret";
  t.after(() => {
    if (previousId === undefined) delete process.env.QQBOT_APP_ID;
    else process.env.QQBOT_APP_ID = previousId;
    if (previousSecret === undefined) delete process.env.QQBOT_APP_SECRET;
    else process.env.QQBOT_APP_SECRET = previousSecret;
  });
  const loaded = await loadConfig({ config: path, dataDir: config.dataDir });
  assert.equal(loaded.appId, "environment-id");
  assert.equal(loaded.appSecret, "environment-secret");
  assert.equal(loaded.defaultPeer, "me");
  assert.equal(loaded.attachments.maxBytes, 104857600);
  assert.equal(loaded.socketPath, config.socketPath);
});

test("invalid configuration never echoes a secret JSON snippet", async (t) => {
  const { config } = await fixture(t);
  const path = join(config.dataDir, "broken.json");
  await writeFile(path, '{"appSecret":"do-not-expose-this-secret", broken}');
  await assert.rejects(loadConfig({ config: path }), (error: unknown) => {
    assert.equal(errorInfo(error).code, "CONFIG");
    assert.doesNotMatch(JSON.stringify(errorInfo(error)), /do-not-expose/);
    return true;
  });
  await writeFile(path, JSON.stringify({ attachments: { maxBytes: 0 } }));
  await assert.rejects(loadConfig({ config: path }), { code: "CONFIG" });
  await assert.rejects(loadConfig({ config: join(config.dataDir, "absent.json") }), {
    code: "CONFIG",
  });
  await assert.rejects(loadConfig({ dataDir: `/tmp/${"x".repeat(150)}` }), { code: "CONFIG" });
});

test("daemon configuration does not read or validate the CLI defaultPeer preference", async (t) => {
  const { config } = await fixture(t);
  const path = join(config.dataDir, "config.json");
  await writeFile(path, JSON.stringify({ defaultPeer: "me" }));
  const daemon = await loadDaemonConfig({ config: path, dataDir: config.dataDir });
  assert.equal(Object.hasOwn(daemon, "defaultPeer"), false);
  await writeFile(path, JSON.stringify({ defaultPeer: 123 }));
  assert.equal(Object.hasOwn(await loadDaemonConfig({ config: path }), "defaultPeer"), false);
  await assert.rejects(loadConfig({ config: path }), { code: "CONFIG" });
});

test("XDG paths are used when there is no explicit configuration", async (t) => {
  const { config } = await fixture(t);
  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousData = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = join(config.dataDir, "config");
  process.env.XDG_DATA_HOME = join(config.dataDir, "data");
  t.after(() => {
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    if (previousData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousData;
  });
  await mkdir(process.env.XDG_CONFIG_HOME);
  const loaded = await loadConfig();
  assert.equal(loaded.dataDir, join(config.dataDir, "data/qqbot-cli"));
});

test("input validation rejects conflicting sends, invalid dates, and invalid limits", () => {
  assert.throws(() => parseSend({ text: "x" }), { code: "INVALID_INPUT" });
  assert.throws(() => parseSend({ to: "me", text: "x", file: "/tmp/x" }), {
    code: "INVALID_INPUT",
  });
  assert.throws(() => parseSend({ to: "me", text: "x", replyTo: "m", proactive: true }), {
    code: "INVALID_INPUT",
  });
  assert.throws(() => parseSend({ to: "me", file: "relative" }), { code: "INVALID_INPUT" });
  assert.throws(() => parseFilter({ since: "yesterday" }), { code: "INVALID_INPUT" });
  assert.throws(
    () => parseFilter({ since: "2026-11-10T00:00:00Z", until: "2026-11-09T00:00:00Z" }),
    { code: "INVALID_INPUT" },
  );
  assert.throws(() => parseFilter({ limit: "0" }), { code: "INVALID_INPUT" });
  assert.equal(
    parseFilter({ since: "2026-11-09T08:00:00+08:00" }).since,
    "2026-11-09T00:00:00.000Z",
  );
});

test("text format defaults to Markdown, accepts plain, and does not apply to files", () => {
  assert.equal(parseSend({ to: "me", text: "# Heading" }).format, "markdown");
  assert.equal(parseSend({ to: "me", text: "literal", format: "plain" }).format, "plain");
  assert.equal(parseSend({ to: "me", text: "**bold**", format: "markdown" }).format, "markdown");
  assert.equal(parseSend({ to: "me", file: "/tmp/report.pdf" }).format, undefined);
  for (const format of ["html", "", false, null]) {
    assert.throws(() => parseSend({ to: "me", text: "text", format }), { code: "INVALID_INPUT" });
  }
  assert.throws(() => parseSend({ to: "me", file: "/tmp/report.pdf", format: "markdown" }), {
    code: "INVALID_INPUT",
  });
});
