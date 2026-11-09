import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AppError, isErrno } from "./errors.ts";

export interface DaemonConfig {
  appId?: string;
  appSecret?: string;
  dataDir: string;
  socketPath: string;
  attachments: { maxBytes: number; timeoutSeconds: number; concurrency: number };
}

export interface Config extends DaemonConfig {
  defaultPeer?: string;
}

interface ConfigOptions {
  config?: string;
  dataDir?: string;
}

export function object(value: unknown, name = "value"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_INPUT", `${name} must be an object`, undefined, 2);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("CONFIG", `${name} must be a non-empty string`);
  }
  return value;
}

function positive(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new AppError("CONFIG", `${name} must be a positive integer`);
  }
  return value as number;
}

async function readConfiguration(options: ConfigOptions): Promise<Record<string, unknown>> {
  const configPath = options.config
    ? resolve(options.config)
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "qqbot-cli/config.json");
  let raw: Record<string, unknown> = {};
  try {
    raw = object(JSON.parse(await readFile(configPath, "utf8")), "configuration");
  } catch (error) {
    if (!isErrno(error, "ENOENT") || options.config) {
      throw new AppError("CONFIG", `Cannot load ${configPath}`, {
        reason: error instanceof SyntaxError ? "Invalid JSON" : String(error),
      });
    }
  }
  return raw;
}

export async function loadConfig(options: ConfigOptions = {}): Promise<Config> {
  const raw = await readConfiguration(options);
  return {
    ...parseDaemonConfig(raw, options),
    defaultPeer: optionalString(raw.defaultPeer, "defaultPeer"),
  };
}

export async function loadDaemonConfig(options: ConfigOptions = {}): Promise<DaemonConfig> {
  return parseDaemonConfig(await readConfiguration(options), options);
}

function parseDaemonConfig(raw: Record<string, unknown>, options: ConfigOptions): DaemonConfig {
  const attachmentConfig =
    raw.attachments === undefined ? {} : object(raw.attachments, "attachments");
  const dataDir = resolve(
    options.dataDir ||
      optionalString(raw.dataDir, "dataDir") ||
      join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "qqbot-cli"),
  );
  const socketPath = join(dataDir, "daemon.sock");
  if (!isAbsolute(dataDir) || Buffer.byteLength(socketPath) > 103) {
    throw new AppError("CONFIG", "Data directory is too long for a Unix socket; use --data-dir");
  }
  return {
    appId: optionalString(process.env.QQBOT_APP_ID || raw.appId, "appId"),
    appSecret: optionalString(process.env.QQBOT_APP_SECRET || raw.appSecret, "appSecret"),
    dataDir,
    socketPath,
    attachments: {
      maxBytes: positive(attachmentConfig.maxBytes, 100 * 1024 * 1024, "attachments.maxBytes"),
      timeoutSeconds: positive(attachmentConfig.timeoutSeconds, 120, "attachments.timeoutSeconds"),
      concurrency: positive(attachmentConfig.concurrency, 2, "attachments.concurrency"),
    },
  };
}
