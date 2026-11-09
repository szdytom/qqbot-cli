import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, request } from "node:http";
import type { Server as NetServer } from "node:net";
import { createServer as createLockServer } from "node:net";
import type { DaemonConfig } from "./config.ts";
import { AppError, errorInfo, isErrno } from "./errors.ts";
import { integer, parseFilter, parseSend } from "./input.ts";
import { Service } from "./service.ts";
import { Store } from "./store.ts";
import type { QQAdapter } from "./types.ts";

export interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
  exitCode?: number;
}

async function listen(server: NetServer, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

async function acquireLock(dataDir: string): Promise<NetServer> {
  if (process.platform !== "linux")
    throw new AppError("PLATFORM", "This version supports Linux only");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if ((await stat(dataDir)).mode & 0o077) {
    throw new AppError(
      "CONFIG",
      "Data directory must be private; use a dedicated directory with mode 0700",
    );
  }
  const canonical = await realpath(dataDir);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 40);
  // Linux abstract socket: atomic ownership, automatically released on process death.
  // The real HTTP socket lives in a private filesystem directory, not this namespace.
  const lock = createLockServer((socket) => socket.destroy());
  try {
    await listen(lock, `\0qqbot-cli-${hash}`);
  } catch (error) {
    lock.close();
    if (isErrno(error, "EADDRINUSE"))
      throw new AppError("ALREADY_RUNNING", "A daemon already owns this data directory");
    throw error;
  }
  return lock;
}

export async function startDaemon(
  config: DaemonConfig,
  adapter: QQAdapter,
): Promise<{
  service: Service;
  done: Promise<void>;
  close: () => Promise<void>;
}> {
  const lock = await acquireLock(config.dataDir);
  const store = new Store(config.dataDir);
  const service = new Service(store, config, adapter);
  const server = createServer((req, res) => {
    route(req, res, service).catch((error: unknown) => respond(res, error));
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  let closing: Promise<void> | undefined;
  let run: Promise<void> = Promise.resolve();
  const close = (): Promise<void> => {
    closing ??= (async () => {
      service.controller.abort();
      const closingServer = closeServer(server);
      try {
        await service.close();
        await run.catch(() => {});
      } finally {
        await closingServer;
        try {
          await removeSocket(config.socketPath);
        } finally {
          await closeServer(lock);
        }
      }
    })();
    return closing;
  };
  try {
    await store.load(true);
    await service.recover();
    await removeSocket(config.socketPath);
    await listen(server, config.socketPath);
    await chmod(config.socketPath, 0o600);
    run = service.run();
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  const done = (async () => {
    try {
      await run;
      if (!service.controller.signal.aborted)
        throw new AppError("QQ_STOPPED", "QQ connection stopped unexpectedly");
      const reason: unknown = service.controller.signal.reason;
      if (reason instanceof AppError) throw reason;
    } finally {
      // Do not await close here: close itself joins this adapter run.
      await close();
    }
  })();
  // Fatal disk errors also abort the adapter and surface through done.
  return { service, done, close };
}

async function removeSocket(path: string): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!info) return;
  if (!info.isSocket())
    throw new AppError(
      "SOCKET_PATH_OCCUPIED",
      "daemon.sock exists and is not a socket; refusing to remove it",
    );
  await rm(path, { force: true });
}

function respond(res: ServerResponse, error?: unknown, data?: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const exitCode = error instanceof AppError ? error.exitCode : 1;
  res.writeHead(error ? 400 : 200, { "Content-Type": "application/json" });
  res.end(
    `${JSON.stringify(error ? { ok: false, error: errorInfo(error), exitCode } : { ok: true, data })}\n`,
  );
}

async function body(req: IncomingMessage): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536)
      throw new AppError("INVALID_INPUT", "Request body exceeds 64 KiB", undefined, 2);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("INVALID_INPUT", "Request body must be JSON", undefined, 2);
  }
}

async function route(req: IncomingMessage, res: ServerResponse, service: Service): Promise<void> {
  const url = new URL(req.url || "/", "http://local");
  const query = Object.fromEntries(url.searchParams);
  if (req.method === "GET" && url.pathname === "/status") {
    respond(res, undefined, {
      running: true,
      pid: process.pid,
      connected: service.connected,
      lastReceivedAt: service.lastReceivedAt ?? null,
      lastError: service.lastError ?? null,
      cursor: service.store.lastSeq,
    });
  } else if (req.method === "GET" && url.pathname === "/peers") {
    respond(res, undefined, { peers: service.store.peers() });
  } else if (req.method === "GET" && url.pathname === "/history") {
    respond(res, undefined, service.store.query(parseFilter(query)));
  } else if (req.method === "GET" && url.pathname === "/wait") {
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.on("close", disconnect);
    try {
      respond(
        res,
        undefined,
        await service.wait(
          parseFilter(query),
          integer(query.timeout, "timeout", 0, 2147483) ?? 60,
          controller.signal,
        ),
      );
    } finally {
      res.off("close", disconnect);
    }
  } else if (req.method === "POST" && url.pathname === "/send") {
    respond(res, undefined, await service.send(parseSend(await body(req))));
  } else {
    throw new AppError("NOT_FOUND", "Unknown IPC endpoint");
  }
}

export function callDaemon(
  socketPath: string,
  endpoint: string,
  data?: unknown,
  signal?: AbortSignal,
): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: endpoint,
        method: data === undefined ? "GET" : "POST",
        signal,
        headers: { "Content-Type": "application/json", Connection: "close" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Envelope;
            if (typeof value.ok !== "boolean") throw new Error("Invalid envelope");
            resolve(value);
          } catch {
            reject(new AppError("IPC_PROTOCOL", "Daemon returned invalid JSON"));
          }
        });
      },
    );
    req.on("error", (error) => {
      if (isErrno(error, "ENOENT") || isErrno(error, "ECONNREFUSED")) {
        reject(new AppError("DAEMON_OFFLINE", "Daemon is not running for this data directory"));
      } else if (signal?.aborted) reject(new AppError("CANCELLED", "Command cancelled"));
      else reject(new AppError("IPC_FAILED", error.message));
    });
    req.end(data === undefined ? undefined : JSON.stringify(data));
  });
}
