import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { OfficialQQAdapter } from "../src/qq.ts";
import { fixture } from "./helpers.ts";

test("official SDK defaults to native Markdown and retains the persisted reply sequence", async (t) => {
  const { config } = await fixture(t);
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.includes("getAppAccessToken"))
      return Response.json({ access_token: "token", expires_in: 7200 });
    return Response.json({ id: "qq-sent", timestamp: 1800000000 });
  });
  const adapter = new OfficialQQAdapter(config);
  const result = await adapter.send({
    peerId: "self",
    text: "report",
    replyPlatformId: "incoming",
    replySeq: 3,
  });
  assert.equal(result.id, "qq-sent");
  assert.equal(result.timestamp, "2027-01-15T08:00:00.000Z");
  assert.deepEqual(requests.at(-1)?.body, {
    msg_type: 2,
    markdown: { content: "report" },
    msg_id: "incoming",
    msg_seq: 3,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.body.clientSecret, "secret");
});

test("explicit plain uses content and proactive Markdown has no reply fields", async (t) => {
  const { config } = await fixture(t);
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    if (url.includes("getAppAccessToken"))
      return Response.json({ access_token: "token", expires_in: 7200 });
    bodies.push(JSON.parse(String(options.body)));
    return Response.json({ id: "sent" });
  });
  const adapter = new OfficialQQAdapter(config);
  await adapter.send({
    peerId: "self",
    text: "**literal**",
    format: "plain",
    replyPlatformId: "in",
    replySeq: 2,
  });
  await adapter.send({ peerId: "self", text: "# Heading", format: "markdown" });
  assert.deepEqual(bodies, [
    { msg_type: 0, content: "**literal**", msg_id: "in", msg_seq: 2 },
    { msg_type: 2, markdown: { content: "# Heading" } },
  ]);
});

test("Markdown permission rejection preserves QQ errors without a plain-text fallback", async (t) => {
  const { config } = await fixture(t);
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    if (url.includes("getAppAccessToken"))
      return Response.json({ access_token: "token", expires_in: 7200 });
    posts++;
    assert.equal(JSON.parse(String(options.body)).msg_type, 2);
    return Response.json({ code: 40034090, message: "not permitted" }, { status: 400 });
  });
  const adapter = new OfficialQQAdapter(config);
  await assert.rejects(adapter.send({ peerId: "self", text: "notice" }), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error && "details" in error);
    assert.equal(error.code, "QQ_REJECTED");
    assert.deepEqual(error.details, { httpStatus: 400, qqCode: 40034090 });
    return true;
  });
  assert.equal(posts, 1);
});

test("lost response and server failure are uncertain, and credential failures are redacted", async (t) => {
  const { config } = await fixture(t);
  let mode = "network";
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("getAppAccessToken")) {
      if (mode === "auth") throw new Error("appSecret=secret");
      return Response.json({ access_token: "token", expires_in: 7200 });
    }
    posts++;
    if (mode === "network") throw new Error("network reset");
    return Response.json({ message: "server failed" }, { status: 503 });
  });
  await assert.rejects(new OfficialQQAdapter(config).send({ peerId: "self", text: "x" }), {
    code: "SEND_UNKNOWN",
  });
  mode = "server";
  await assert.rejects(new OfficialQQAdapter(config).send({ peerId: "self", text: "x" }), {
    code: "SEND_UNKNOWN",
  });
  mode = "auth";
  await assert.rejects(
    new OfficialQQAdapter(config).send({ peerId: "self", text: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /appSecret=secret/);
      return true;
    },
  );
  assert.equal(posts, 2);
});

test("media upload does not send implicitly; media POST retains explicit reply metadata", async (t) => {
  const { config } = await fixture(t);
  const file = join(config.dataDir, "image.png");
  await writeFile(file, "image contents");
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.includes("getAppAccessToken"))
      return Response.json({ access_token: "token", expires_in: 7200 });
    if (url.endsWith("/files"))
      return Response.json({ file_info: "uploaded", file_uuid: "u", ttl: 300 });
    return Response.json({ id: "sent" });
  });
  const adapter = new OfficialQQAdapter(config);
  const fileInfo = await adapter.upload("self", file);
  assert.equal(fileInfo, "uploaded");
  assert.equal(requests.at(-1)?.body.srv_send_msg, false);
  assert.equal(requests.at(-1)?.body.file_type, 1);
  assert.equal(requests.filter((r) => r.url.endsWith("/messages")).length, 0);
  await adapter.send({ peerId: "self", text: "", fileInfo, replyPlatformId: "in", replySeq: 4 });
  assert.deepEqual(requests.at(-1)?.body, {
    msg_type: 7,
    content: " ",
    media: { file_info: "uploaded" },
    msg_id: "in",
    msg_seq: 4,
  });
});
