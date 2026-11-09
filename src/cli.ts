#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadDaemonConfig } from "./config.ts";
import { AppError, errorInfo, usage } from "./errors.ts";
import { integer, parseFilter, parseSend } from "./input.ts";
import type { Envelope } from "./ipc.ts";
import { callDaemon, startDaemon } from "./ipc.ts";
import { Store } from "./store.ts";

const help = `qqbot — QQ notifications without an agent runtime

  qqbot daemon run                         Run in foreground (use systemd)
  qqbot status                             Show daemon and QQ connection status
  qqbot peers                              List observed C2C peers
  qqbot send --text TEXT [--to OPENID]       Send Markdown by default; '-' reads stdin
  qqbot send --file PATH [--caption TEXT]   Upload and send a local file
  qqbot history [--peer OPENID]             Query recorded messages
  qqbot wait [--from OPENID]                Wait for one incoming message

Global: --config PATH, --data-dir PATH, --help, --version
Send:   --format markdown|plain (text only; default markdown), --reply-to LOCAL_ID | --proactive
History: --direction in|out, --since ISO, --until ISO, --contains TEXT,
         --after CURSOR, --limit N (default 50, maximum 10000)
Wait:   --after CURSOR, --contains TEXT, --timeout SECONDS (default 60; 0 = forever)

Business output is JSON on stdout; diagnostics go to stderr.
Exit codes: 0 success, 1 operation failed, 2 invalid usage, 3 wait timeout.
No cursor: wait starts now. With cursor: history is checked before subscribing.
`;

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        "data-dir": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
        to: { type: "string" },
        text: { type: "string" },
        format: { type: "string" },
        file: { type: "string" },
        caption: { type: "string" },
        "reply-to": { type: "string" },
        proactive: { type: "boolean" },
        peer: { type: "string" },
        from: { type: "string" },
        direction: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        contains: { type: "string" },
        after: { type: "string" },
        limit: { type: "string" },
        timeout: { type: "string" },
      },
    });
    if (values.version) {
      print({ ok: true, data: { version: "0.1.0" } });
      return 0;
    }
    if (values.help || !positionals.length) {
      process.stdout.write(help);
      return 0;
    }
    const [command, subcommand] = positionals;
    const allowed: Record<string, string[]> = {
      daemon: [],
      status: [],
      peers: [],
      send: ["to", "text", "format", "file", "caption", "reply-to", "proactive"],
      history: ["peer", "direction", "since", "until", "contains", "after", "limit"],
      wait: ["from", "contains", "after", "timeout"],
    };
    if (!command || !allowed[command]) usage("Unknown command; use --help");
    if (
      (command === "daemon" && (subcommand !== "run" || positionals.length !== 2)) ||
      (command !== "daemon" && positionals.length !== 1)
    )
      usage("Unexpected positional arguments; use --help");
    for (const name of Object.keys(values)) {
      if (!["config", "data-dir", "help", "version", ...(allowed[command] || [])].includes(name)) {
        usage(`--${name} is not valid for ${command}`);
      }
    }
    const configOptions = { config: values.config, dataDir: values["data-dir"] };
    if (command === "daemon") {
      const config = await loadDaemonConfig(configOptions);
      const { OfficialQQAdapter } = await import("./qq.ts");
      const daemon = await startDaemon(config, new OfficialQQAdapter(config));
      const stop = () => {
        void daemon.close().catch(() => {});
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      process.stderr.write(
        `${JSON.stringify({ level: "info", message: "Daemon started", socketPath: config.socketPath })}\n`,
      );
      try {
        await daemon.done;
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
      print({ ok: true, data: { stopped: true } });
      return 0;
    }
    const config = await loadConfig(configOptions);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      let result: Envelope;
      if (command === "send") {
        const to = values.to ?? config.defaultPeer;
        if (!to) usage("Set defaultPeer in the CLI configuration or pass --to OPENID");
        const text = values.text === "-" ? await readStdin(controller.signal) : values.text;
        const input = parseSend({
          to,
          text,
          format: values.format,
          file: values.file ? resolve(values.file) : undefined,
          caption: values.caption,
          replyTo: values["reply-to"],
          proactive: values.proactive,
        });
        result = await callDaemon(config.socketPath, "/send", input, controller.signal);
      } else {
        let endpoint = `/${command}`;
        let filter: ReturnType<typeof parseFilter> | undefined;
        if (command === "history" || command === "wait") {
          filter = parseFilter({
            peerId: values.peer ?? values.from ?? config.defaultPeer,
            direction: values.direction,
            since: values.since,
            until: values.until,
            contains: values.contains,
            after: values.after,
            limit: values.limit,
          });
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(filter))
            if (value !== undefined) params.set(key, String(value));
          if (command === "wait")
            params.set("timeout", String(integer(values.timeout, "timeout", 0, 2147483) ?? 60));
          endpoint += `?${params}`;
        }
        try {
          result = await callDaemon(config.socketPath, endpoint, undefined, controller.signal);
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "DAEMON_OFFLINE") throw error;
          if (command === "status")
            result = { ok: true, data: { running: false, connected: false } };
          else if (command === "history" || command === "peers") {
            const store = new Store(config.dataDir);
            await store.load();
            result = {
              ok: true,
              data: command === "peers" ? { peers: store.peers() } : store.query(filter),
            };
          } else throw error;
        }
      }
      print(result);
      return result.ok ? 0 : (result.exitCode ?? 1);
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  } catch (error) {
    const isArgumentError =
      error instanceof TypeError &&
      "code" in error &&
      String(error.code).startsWith("ERR_PARSE_ARGS");
    const normalized = isArgumentError ? new AppError("USAGE", error.message, undefined, 2) : error;
    const exitCode = normalized instanceof AppError ? normalized.exitCode : 1;
    print({ ok: false, error: errorInfo(normalized), exitCode });
    return exitCode;
  }
}

async function readStdin(signal: AbortSignal): Promise<string> {
  const abort = () => process.stdin.destroy(new AppError("CANCELLED", "Command cancelled"));
  if (signal.aborted) throw new AppError("CANCELLED", "Command cancelled");
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      length += buffer.length;
      if (length > 60 * 1024) usage("stdin exceeds the 60 KiB text limit");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function print(envelope: Envelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

if (import.meta.main) process.exitCode = await main();
