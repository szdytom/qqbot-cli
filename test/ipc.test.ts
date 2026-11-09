import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { callDaemon, startDaemon } from "../src/ipc.ts";
import { FakeQQ, testConfig, until } from "./helpers.ts";

const exec = promisify(execFile);
const cliPath = resolve("src/cli.ts");

async function cli(
  dataDir: string,
  args: string[],
  stdin?: string,
): Promise<{ code: number; data: Record<string, unknown>; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "--data-dir", dataDir, ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: join(dataDir, "config") },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b;
    });
    child.stderr.on("data", (b) => {
      stderr += b;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code: code ?? 1, data: JSON.parse(stdout), stderr });
      } catch {
        reject(new Error(`Invalid CLI output: ${stdout}\n${stderr}`));
      }
    });
    child.stdin.end(stdin);
  });
}

test("Unix socket serves CLI send/history/wait and permits offline reads after shutdown", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-ipc-"));
  const config = testConfig(dataDir);
  const adapter = new FakeQQ();
  const daemon = await startDaemon(config, adapter);
  t.after(async () => {
    await daemon.close();
    await daemon.done;
    await rm(dataDir, { recursive: true, force: true });
  });
  const status = await cli(dataDir, ["status"]);
  assert.equal(status.code, 0);
  assert.equal(status.stderr, "");
  assert.equal((status.data.data as { connected: boolean }).connected, true);
  await assert.rejects(startDaemon(config, new FakeQQ()), { code: "ALREADY_RUNNING" });
  await adapter.incoming();
  const peers = await cli(dataDir, ["peers"]);
  assert.equal((peers.data.data as { peers: unknown[] }).peers.length, 1);
  adapter.onSend = async () => {
    await adapter.incoming("fast", "yes");
  };
  const sent = await cli(dataDir, ["send", "--to", "self", "--text", "-"], "a report\nfrom stdin");
  assert.equal(sent.code, 0);
  assert.equal(adapter.sends[0]?.text, "a report\nfrom stdin");
  const cursor = (sent.data.data as { cursor: number }).cursor;
  const response = await cli(dataDir, [
    "wait",
    "--from",
    "self",
    "--after",
    String(cursor),
    "--timeout",
    "1",
  ]);
  assert.equal(
    (response.data.data as { messages: Array<{ text: string }> }).messages[0]?.text,
    "yes",
  );
  const timeout = await cli(dataDir, ["wait", "--timeout", "1"]);
  assert.equal(timeout.code, 3);
  assert.equal((timeout.data.error as { code: string }).code, "WAIT_TIMEOUT");
  const invalid = await cli(dataDir, ["send", "--text", "bad", "--file", "missing"]);
  assert.equal(invalid.code, 2);
  assert.equal((await cli(dataDir, ["wait", "--limit", "1"])).code, 2);
  assert.equal((await cli(dataDir, ["history", "--after", "-1"])).code, 2);
  assert.equal((await cli(dataDir, ["--nonsense"])).code, 2);
  const file = join(dataDir, "artifact.txt");
  await writeFile(file, "artifact");
  assert.equal(
    (await cli(dataDir, ["send", "--to", "self", "--file", file, "--caption", "file"])).code,
    0,
  );
  assert.equal(adapter.uploads.length, 1);
  const waiting = callDaemon(config.socketPath, "/wait?timeout=0");
  await until(() => daemon.service.store.listenerCount("append") === 1);
  await daemon.close();
  assert.equal((await waiting).error?.code, "SHUTTING_DOWN");
  await daemon.done;
  const history = await cli(dataDir, ["history", "--direction", "out"]);
  assert.equal(history.code, 0);
  assert.equal((history.data.data as { messages: unknown[] }).messages.length, 2);
  const offline = await cli(dataDir, ["status"]);
  assert.equal((offline.data.data as { running: boolean }).running, false);
  assert.equal((await cli(dataDir, ["wait", "--timeout", "1"])).code, 1);
});

test("CLI resolves and reloads defaultPeer while daemon only uses explicit request targets", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-default-"));
  const config = testConfig(dataDir);
  const configDirectory = join(dataDir, "config/qqbot-cli");
  await mkdir(configDirectory, { recursive: true });
  const configPath = join(configDirectory, "config.json");
  await writeFile(configPath, JSON.stringify({ defaultPeer: "self" }));
  const adapter = new FakeQQ();
  const daemon = await startDaemon(config, adapter);
  t.after(async () => {
    await daemon.close();
    await daemon.done;
    await rm(dataDir, { recursive: true, force: true });
  });
  await adapter.incoming("other-message", "other input", "other");
  await adapter.incoming("self-message", "self input", "self");
  const peersIn = (result: { data: Record<string, unknown> }) =>
    (result.data.data as { messages: Array<{ peerId: string }> }).messages.map((m) => m.peerId);
  assert.deepEqual(peersIn(await cli(dataDir, ["history"])), ["self"]);
  assert.deepEqual(peersIn(await cli(dataDir, ["wait", "--after", "0", "--timeout", "1"])), [
    "self",
  ]);
  const rawHistory = await callDaemon(config.socketPath, "/history");
  assert.equal((rawHistory.data as { messages: unknown[] }).messages.length, 2);
  const rawWait = await callDaemon(config.socketPath, "/wait?after=0&timeout=1");
  assert.equal(
    (rawWait.data as { messages: Array<{ peerId: string }> }).messages[0]?.peerId,
    "other",
  );
  const missingTarget = await callDaemon(config.socketPath, "/send", { text: "no target" });
  assert.equal(missingTarget.error?.code, "INVALID_INPUT");
  assert.equal(adapter.sends.length, 0);
  assert.equal((await cli(dataDir, ["send", "--text", "first default"])).code, 0);
  await writeFile(configPath, JSON.stringify({ defaultPeer: "other" }));
  assert.equal((await cli(dataDir, ["send", "--text", "changed default"])).code, 0);
  assert.equal((await cli(dataDir, ["send", "--text", "explicit", "--to", "self"])).code, 0);
  assert.deepEqual(
    adapter.sends.map((s) => s.peerId),
    ["self", "other", "self"],
  );
  assert.deepEqual(peersIn(await cli(dataDir, ["history", "--direction", "in"])), ["other"]);
  assert.deepEqual(
    peersIn(await cli(dataDir, ["history", "--peer", "self", "--direction", "in"])),
    ["self"],
  );
  assert.deepEqual(peersIn(await cli(dataDir, ["wait", "--after", "0", "--timeout", "1"])), [
    "other",
  ]);
  assert.deepEqual(
    peersIn(await cli(dataDir, ["wait", "--from", "self", "--after", "0", "--timeout", "1"])),
    ["self"],
  );
  await daemon.close();
  await daemon.done;
  assert.deepEqual(peersIn(await cli(dataDir, ["history", "--direction", "in"])), ["other"]);
  await writeFile(configPath, "{}");
  assert.deepEqual(peersIn(await cli(dataDir, ["history", "--direction", "in"])), [
    "other",
    "self",
  ]);
  assert.equal((await cli(dataDir, ["send", "--text", "no default or explicit target"])).code, 2);
});

test("CLI and IPC carry Markdown defaults and explicit plain through sending and history", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-format-"));
  const config = testConfig(dataDir);
  const adapter = new FakeQQ();
  const daemon = await startDaemon(config, adapter);
  t.after(async () => {
    await daemon.close();
    await daemon.done;
    await rm(dataDir, { recursive: true, force: true });
  });
  const markdown = "# Heading\n\n**bold**\n";
  const first = await cli(dataDir, ["send", "--to", "self", "--text", "-"], markdown);
  assert.equal(first.code, 0);
  assert.equal((first.data.data as { message: { format: string } }).message.format, "markdown");
  assert.equal(adapter.sends[0]?.text, markdown);
  const plain = await cli(
    dataDir,
    ["send", "--to", "self", "--text", "-", "--format", "plain"],
    markdown,
  );
  assert.equal(plain.code, 0);
  assert.equal((plain.data.data as { message: { format: string } }).message.format, "plain");
  assert.equal(
    (await cli(dataDir, ["send", "--to", "self", "--text", "explicit", "--format", "markdown"]))
      .code,
    0,
  );
  const direct = await callDaemon(config.socketPath, "/send", { to: "self", text: "IPC default" });
  assert.equal(direct.ok, true);
  assert.deepEqual(
    adapter.sends.map((s) => s.format),
    ["markdown", "plain", "markdown", "markdown"],
  );
  for (const args of [
    ["send", "--to", "self", "--text", "invalid", "--format", "html"],
    ["send", "--to", "self", "--file", "/tmp/report.pdf", "--format", "plain"],
    ["history", "--format", "plain"],
  ])
    assert.equal((await cli(dataDir, args)).code, 2);
  const invalid = await callDaemon(config.socketPath, "/send", {
    to: "self",
    text: "invalid",
    format: "html",
  });
  assert.equal(invalid.error?.code, "INVALID_INPUT");
  assert.equal(adapter.sends.length, 4);
  await daemon.close();
  await daemon.done;
  const history = await cli(dataDir, ["history", "--direction", "out"]);
  assert.deepEqual(
    (history.data.data as { messages: Array<{ format: string }> }).messages.map((m) => m.format),
    ["markdown", "plain", "markdown", "markdown"],
  );
});

test("HTTP wait cancellation removes the waiter; reconnect does not consume messages", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-ipc-"));
  const daemon = await startDaemon(testConfig(dataDir), new FakeQQ());
  t.after(async () => {
    await daemon.close();
    await daemon.done;
    await rm(dataDir, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const waiting = callDaemon(
    daemon.service.config.socketPath,
    "/wait?timeout=0",
    undefined,
    controller.signal,
  );
  const cancelled = assert.rejects(waiting, { code: "CANCELLED" });
  await until(() => daemon.service.store.listenerCount("append") === 1);
  controller.abort();
  await cancelled;
  await until(() => daemon.service.store.listenerCount("append") === 0);
});

test("SIGKILL releases the kernel lock and the next daemon removes its stale filesystem socket", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-kill-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const script = `import { startDaemon } from ${JSON.stringify(resolve("src/ipc.ts"))};
    import { FakeQQ, testConfig } from ${JSON.stringify(resolve("test/helpers.ts"))};
    const d = await startDaemon(testConfig(process.argv[1]), new FakeQQ());
    console.log('ready'); await d.done;`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, dataDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code) reject(new Error(`Worker exited: ${code}`));
    });
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  assert.equal((await stat(testConfig(dataDir).socketPath)).isSocket(), true);
  const next = await startDaemon(testConfig(dataDir), new FakeQQ());
  await next.close();
  await next.done;
});

test("adapter failure closes IPC, releases ownership, and is observable", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-fatal-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const adapter = new FakeQQ();
  adapter.run = async () => {
    throw new Error("invalid credentials");
  };
  const daemon = await startDaemon(testConfig(dataDir), adapter);
  await assert.rejects(daemon.done, /invalid credentials/);
  const next = await startDaemon(testConfig(dataDir), new FakeQQ());
  await next.close();
  await next.done;
});

test("version/help do not require credentials or a running service", async () => {
  const version = await exec(process.execPath, [cliPath, "--version"]);
  assert.equal(JSON.parse(version.stdout).data.version, "0.1.0");
  const help = await exec(process.execPath, [cliPath, "--help"]);
  assert.match(help.stdout, /--after CURSOR/);
});

test("malformed JSON from a socket peer becomes a protocol error", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-bad-"));
  const socketPath = join(dataDir, "bad.sock");
  const server = createServer((_req, res) => res.end("oops"));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });
  await assert.rejects(callDaemon(socketPath, "/status"), { code: "IPC_PROTOCOL" });
});

test("daemon refuses a shared data directory and preserves a non-socket at daemon.sock", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-protect-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = testConfig(dataDir);
  await chmod(dataDir, 0o755);
  await assert.rejects(startDaemon(config, new FakeQQ()), { code: "CONFIG" });
  assert.equal((await stat(dataDir)).mode & 0o777, 0o755);
  await chmod(dataDir, 0o700);
  await writeFile(config.socketPath, "keep me");
  await assert.rejects(startDaemon(config, new FakeQQ()), { code: "SOCKET_PATH_OCCUPIED" });
  assert.equal(await readFile(config.socketPath, "utf8"), "keep me");
  await rm(config.socketPath);
  const daemon = await startDaemon(config, new FakeQQ());
  await daemon.close();
  await daemon.done;
});

test("runtime disk failure exits and releases the daemon lock", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-disk-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = testConfig(dataDir);
  const adapter = new FakeQQ();
  const daemon = await startDaemon(config, adapter);
  const done = assert.rejects(daemon.done, { code: "PERSISTENCE" });
  await adapter.incoming("first");
  await rename(join(dataDir, "events"), join(dataDir, "events-backup"));
  await writeFile(join(dataDir, "events"), "disk failure");
  await assert.rejects(adapter.incoming("second"));
  await done;
  await rm(join(dataDir, "events"));
  await rename(join(dataDir, "events-backup"), join(dataDir, "events"));
  const next = await startDaemon(config, new FakeQQ());
  assert.equal(next.service.store.messages.size, 1);
  await next.close();
  await next.done;
});

test("SIGTERM cancels text input even while stdin has not reached EOF", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "qq-stdin-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const script = `import { main } from ${JSON.stringify(cliPath)};
    const ready = setInterval(() => {
      if (process.listenerCount('SIGTERM')) { clearInterval(ready); console.error('ready'); }
    }, 1);
    process.exitCode = await main(['--data-dir', process.argv[1], 'send', '--to', 'self', '--text', '-']);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, dataDir], {
    stdio: "pipe",
  });
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  await new Promise<void>((resolve, reject) => {
    child.stderr.once("data", () => resolve());
    child.once("error", reject);
  });
  child.kill("SIGTERM");
  assert.equal(await exited, 1);
  assert.equal(JSON.parse(output).error.code, "CANCELLED");
});
