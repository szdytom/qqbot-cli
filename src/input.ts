import { isAbsolute } from "node:path";
import { object } from "./config.ts";
import { AppError } from "./errors.ts";
import type { MessageFilter, SendInput } from "./types.ts";

export function stringValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("INVALID_INPUT", `${name} must be a non-empty string`, undefined, 2);
  }
  return value;
}

export function integer(
  value: unknown,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined) return undefined;
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new AppError(
      "INVALID_INPUT",
      `${name} must be an integer between ${min} and ${max}`,
      undefined,
      2,
    );
  }
  return number;
}

export function parseFilter(raw: Record<string, unknown>): MessageFilter {
  const direction = raw.direction;
  if (direction !== undefined && direction !== "in" && direction !== "out") {
    throw new AppError("INVALID_INPUT", "direction must be in or out", undefined, 2);
  }
  const date = (value: unknown, name: string) => {
    if (value === undefined) return undefined;
    const text = stringValue(value, name) as string;
    if (
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text) ||
      Number.isNaN(Date.parse(text))
    ) {
      throw new AppError(
        "INVALID_INPUT",
        `${name} must be an ISO timestamp with timezone`,
        undefined,
        2,
      );
    }
    return new Date(text).toISOString();
  };
  const since = date(raw.since, "since");
  const until = date(raw.until, "until");
  if (since && until && since > until)
    throw new AppError("INVALID_INPUT", "since must not exceed until", undefined, 2);
  return {
    peerId: stringValue(raw.peerId, "peerId"),
    direction,
    contains: stringValue(raw.contains, "contains"),
    since,
    until,
    after: integer(raw.after, "after"),
    limit: integer(raw.limit, "limit", 1, 10000),
  };
}

export function parseSend(value: unknown): SendInput {
  const raw = object(value);
  const to = stringValue(raw.to, "to");
  if (!to) throw new AppError("INVALID_INPUT", "to is required", undefined, 2);
  const text = stringValue(raw.text, "text");
  const file = stringValue(raw.file, "file");
  if (file && !isAbsolute(file))
    throw new AppError("INVALID_INPUT", "file must be an absolute local path", undefined, 2);
  const caption = stringValue(raw.caption, "caption");
  const replyTo = stringValue(raw.replyTo, "replyTo");
  if ((text === undefined) === (file === undefined)) {
    throw new AppError("INVALID_INPUT", "Supply exactly one of --text and --file", undefined, 2);
  }
  if (caption && !file)
    throw new AppError("INVALID_INPUT", "--caption requires --file", undefined, 2);
  if (raw.format !== undefined && raw.format !== "markdown" && raw.format !== "plain") {
    throw new AppError("INVALID_INPUT", "format must be markdown or plain", undefined, 2);
  }
  if (file && raw.format !== undefined) {
    throw new AppError("INVALID_INPUT", "--format is only supported with --text", undefined, 2);
  }
  const format = file ? undefined : (raw.format ?? "markdown");
  if (raw.proactive !== undefined && typeof raw.proactive !== "boolean") {
    throw new AppError("INVALID_INPUT", "proactive must be boolean", undefined, 2);
  }
  if (raw.proactive && replyTo)
    throw new AppError(
      "INVALID_INPUT",
      "--proactive and --reply-to are mutually exclusive",
      undefined,
      2,
    );
  return {
    to,
    text,
    format,
    file,
    caption,
    replyTo,
    proactive: raw.proactive as boolean | undefined,
  };
}
