import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  ApiClient,
  ApiError,
  ChunkedMediaApi,
  GatewayConnection,
  getMaxUploadSize,
  LARGE_FILE_THRESHOLD,
  MediaApi,
  MediaFileType,
  TokenManager,
} from "@tencent-connect/qqbot-nodejs/protocol";
import type { DaemonConfig } from "./config.ts";
import { AppError } from "./errors.ts";
import type { AdapterHandlers, QQAdapter } from "./types.ts";

export class OfficialQQAdapter implements QQAdapter {
  private readonly creds: { appId: string; clientSecret: string };
  private readonly client = new ApiClient();
  private readonly tokens = new TokenManager();
  private readonly media = new MediaApi(this.client, this.tokens);
  private readonly chunked = new ChunkedMediaApi(this.client, this.tokens);

  constructor(config: DaemonConfig) {
    if (!config.appId || !config.appSecret) {
      throw new AppError("CONFIG", "Set appId/appSecret or QQBOT_APP_ID/QQBOT_APP_SECRET");
    }
    this.creds = { appId: config.appId, clientSecret: config.appSecret };
  }

  private async token(): Promise<string> {
    try {
      return await this.tokens.getAccessToken(this.creds.appId, this.creds.clientSecret);
    } catch {
      // Token endpoint errors may contain credentials; do not forward their bodies.
      throw new AppError("QQ_AUTH", "Could not acquire QQ access token; check credentials/network");
    }
  }

  async run(handlers: AdapterHandlers, signal: AbortSignal): Promise<void> {
    await this.token();
    this.tokens.startBackgroundRefresh(this.creds.appId, this.creds.clientSecret);
    const gateway = new GatewayConnection({
      account: { accountId: this.creds.appId, ...this.creds },
      abortSignal: signal,
      // C2C/group intent. Ignore group messages below; no guild intents are needed.
      intents: 1 << 25,
      reconnect: { maxAttempts: 10 },
      getAccessToken: () => this.token(),
      clearTokenCache: () => this.tokens.clearCache(this.creds.appId),
      getGatewayUrl: async (accessToken) => {
        const result = await this.client.request<{ url: string }>(accessToken, "GET", "/gateway");
        return result.url;
      },
      onReady: () => handlers.onConnection(true),
      onResumed: () => handlers.onConnection(true),
      onDisconnected: () => handlers.onConnection(false),
      onError: handlers.onError,
      onMessage: async (message) => {
        if (message.kind !== "c2c" || message.senderIsBot) return;
        await handlers.onMessage({
          platformId: message.messageId,
          peerId: message.senderId,
          text: message.content,
          timestamp: platformTimestamp(message.timestamp) ?? new Date().toISOString(),
          attachments: message.attachments?.map((a) => ({
            url: a.url.startsWith("//") ? `https:${a.url}` : a.url,
            name: a.filename,
            contentType: a.content_type,
            size: a.size,
          })),
        });
      },
    });
    try {
      await gateway.start();
    } finally {
      this.tokens.stopBackgroundRefresh();
      handlers.onConnection(false);
    }
  }

  async upload(peerId: string, file: string): Promise<string> {
    const info = await stat(file);
    const fileType = /\.(png|jpe?g|gif|webp|bmp)$/i.test(extname(file))
      ? MediaFileType.IMAGE
      : MediaFileType.FILE;
    if (!info.isFile() || info.size === 0 || info.size > getMaxUploadSize(fileType)) {
      throw new AppError("FILE_INVALID", "File is empty, not regular, or exceeds QQ's size limit", {
        maxBytes: getMaxUploadSize(fileType),
      });
    }
    const result =
      info.size > LARGE_FILE_THRESHOLD
        ? await this.chunked.uploadChunked({
            scope: "c2c",
            targetId: peerId,
            fileType,
            source: { kind: "localPath", path: file, size: info.size },
            creds: this.creds,
            fileName: basename(file),
          })
        : await this.media.uploadMedia("c2c", peerId, fileType, this.creds, {
            localPath: file,
            fileName: basename(file),
            srvSendMsg: false,
          });
    return result.file_info;
  }

  async send(input: Parameters<QQAdapter["send"]>[0]): ReturnType<QQAdapter["send"]> {
    const token = await this.token();
    const content = input.fileInfo
      ? { msg_type: 7, content: input.text || " ", media: { file_info: input.fileInfo } }
      : input.format === "plain"
        ? { msg_type: 0, content: input.text }
        : { msg_type: 2, markdown: { content: input.text } };
    const body = {
      ...content,
      ...(input.replyPlatformId ? { msg_id: input.replyPlatformId, msg_seq: input.replySeq } : {}),
    };
    try {
      // Own the persisted reply sequence; the SDK's convenience API generates a random one.
      // Never retry a message POST: a lost response does not imply non-delivery.
      const response = await this.client.request<{ id: string; timestamp?: string | number }>(
        token,
        "POST",
        `/v2/users/${encodeURIComponent(input.peerId)}/messages`,
        body,
      );
      if (typeof response.id !== "string" || !response.id)
        throw new AppError("SEND_UNKNOWN", "QQ returned no message ID");
      return {
        id: response.id,
        timestamp:
          response.timestamp === undefined ? undefined : platformTimestamp(response.timestamp),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof ApiError) {
        const unknown =
          error.httpStatus === 0 ||
          error.httpStatus >= 500 ||
          (error.httpStatus >= 200 && error.httpStatus < 300 && error.bizCode === undefined);
        throw new AppError(
          unknown ? "SEND_UNKNOWN" : "QQ_REJECTED",
          error.bizMessage || error.message,
          {
            httpStatus: error.httpStatus,
            qqCode: error.bizCode,
          },
        );
      }
      throw new AppError("SEND_UNKNOWN", "QQ request failed without a definitive response");
    }
  }
}

function platformTimestamp(value: string | number): string | undefined {
  const numeric = typeof value === "number" || /^\d+$/.test(value) ? Number(value) : undefined;
  const date = new Date(numeric === undefined ? value : numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
