import type { ErrorInfo } from "./errors.ts";

export type TextFormat = "markdown" | "plain";

export interface Attachment {
  id: string;
  url?: string;
  name?: string;
  contentType?: string;
  size?: number;
  status: "pending" | "ready" | "failed";
  localPath?: string;
  error?: string;
}

export interface Message {
  id: string;
  cursor: number;
  direction: "in" | "out";
  peerId: string;
  platformId?: string;
  text: string;
  format?: TextFormat;
  timestamp: string;
  recordedAt: string;
  attachments: Attachment[];
  status: "received" | "pending" | "accepted" | "failed" | "unknown";
  replyTo?: string;
  replySeq?: number;
  responseCursor?: number;
  error?: ErrorInfo;
}

export type EventBody =
  | { kind: "message.received"; message: Message }
  | { kind: "send.started"; message: Message }
  | {
      kind: "send.finished";
      messageId: string;
      status: "accepted" | "failed" | "unknown";
      platformId?: string;
      timestamp?: string;
      error?: ErrorInfo;
    }
  | { kind: "attachment.updated"; messageId: string; attachment: Attachment };

export type StoredEvent = EventBody & { version: 1; seq: number; recordedAt: string };

export interface MessageFilter {
  peerId?: string;
  direction?: "in" | "out";
  contains?: string;
  since?: string;
  until?: string;
  after?: number;
  limit?: number;
}

export interface SendInput {
  to: string;
  text?: string;
  format?: TextFormat;
  file?: string;
  caption?: string;
  replyTo?: string;
  proactive?: boolean;
}

export interface InboundMessage {
  platformId: string;
  peerId: string;
  text: string;
  timestamp: string;
  attachments?: Array<Omit<Attachment, "id" | "status">>;
}

export interface AdapterHandlers {
  onMessage: (message: InboundMessage) => Promise<void>;
  onConnection: (connected: boolean) => void;
  onError: (error: unknown) => void;
}

export interface QQAdapter {
  run(handlers: AdapterHandlers, signal: AbortSignal): Promise<void>;
  upload(peerId: string, file: string): Promise<string>;
  send(input: {
    peerId: string;
    text: string;
    format?: TextFormat;
    fileInfo?: string;
    replyPlatformId?: string;
    replySeq?: number;
  }): Promise<{ id: string; timestamp?: string }>;
}
