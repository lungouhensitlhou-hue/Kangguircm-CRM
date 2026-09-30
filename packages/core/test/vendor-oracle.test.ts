/**
 * Cross-checks against the vendors' OWN official libraries (dev-only dependencies), so our webhook verification and
 * request formats are proven compatible with what the vendors actually produce and accept, not just with our reading of the docs.
 */
import crypto from "node:crypto";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Webhook } from "svix";
import { EventWebhook } from "@sendgrid/eventwebhook";
import { Resend } from "resend";
import type { WebhookEventPayload } from "resend";
import { ServerClient } from "postmark";
import type { BounceWebhook, DeliveryWebhook, SpamComplaintWebhook } from "postmark/dist/client/models";
import OpenAI from "openai";
import sgMail from "@sendgrid/mail";
import { verifyResend, verifySendGrid, parseResend, parsePostmark } from "../src/providers/email-events";
import { ResendMailer, PostmarkMailer, SendGridMailer } from "../src/providers/mailer";
import { OpenAICompatLLM } from "../src/providers/llm-openai";
import { z } from "zod";

interface Captured { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }
let server: http.Server, base = "";
let captured: Captured[] = [];
const REPLY: Record<string, any> = { "/emails": { id: "re_123" }, "/email": { MessageID: "pm-1", ErrorCode: 0, To: "x", SubmittedAt: "now", Message: "OK" }, "/v3/mail/send": "", "/chat/completions": { choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = raw; try { body = JSON.parse(raw); } catch { /* keep raw */ }
      captured.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const path = req.url!.split("?")[0].replace(/^\/v1/, "");
      if (path === "/v3/mail/send") { res.writeHead(202, { "x-message-id": "sg-msg-1" }); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(REPLY[path] ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
const last = () => captured[captured.length - 1];

describe("webhook signatures: vendor library signs, we verify", () => {
  it("Resend/Svix: signatures produced by the official svix library are accepted; tampering is not", () => {
    const secret = "whsec_" + crypto.randomBytes(32).toString("base64");
    const payload = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });
    const id = "msg_2abc", ts = new Date();
    const sig = new Webhook(secret).sign(id, ts, payload);
    const headers = { "svix-id": id, "svix-timestamp": String(Math.floor(ts.getTime() / 1000)), "svix-signature": sig };
    new Webhook(secret).verify(payload, headers); // sanity: the vendor accepts its own output
    expect(verifyResend(headers, payload, secret)).toBe(true);
    expect(verifyResend(headers, payload.replace("e1", "e2"), secret)).toBe(false);
    expect(verifyResend({ ...headers, "svix-signature": sig.replace(/.$/, "A") }, payload, secret)).toBe(false);
    expect(verifyResend({ ...headers, "Svix-Id": "x", "svix-id": undefined } as any, payload, secret)).toBe(false);
    // header-name case and multi-signature rotation format (space separated)
    expect(verifyResend({ "Svix-Id": id, "Svix-Timestamp": headers["svix-timestamp"], "Svix-Signature": `v1,AAAA ${sig}` }, payload, secret)).toBe(true);
  });

  it("SendGrid: the official EventWebhook verifier and ours agree on a real ECDSA signature and key encoding", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const keyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64"); // the format SendGrid displays
    const payload = JSON.stringify([{ email: "a@b.test", event: "delivered", sg_message_id: "abc.filter" }]) + "\r\n"; // SendGrid appends CRLF
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.sign("sha256", Buffer.from(ts + payload), privateKey).toString("base64");
    const official = new EventWebhook();
    const key = official.convertPublicKeyToECDSA(keyB64);
    expect(official.verifySignature(key, payload, sig, ts)).toBe(true);
    expect(verifySendGrid({ "X-Twilio-Email-Event-Webhook-Signature": sig, "X-Twilio-Email-Event-Webhook-Timestamp": ts }, payload, keyB64)).toBe(true);
    const bad = payload.replace("delivered", "bounce");
    expect(official.verifySignature(key, bad, sig, ts)).toBe(false);
    expect(verifySendGrid({ "X-Twilio-Email-Event-Webhook-Signature": sig, "X-Twilio-Email-Event-Webhook-Timestamp": ts }, bad, keyB64)).toBe(false);
    // the CRLF matters: verification must use the exact raw bytes
    expect(verifySendGrid({ "X-Twilio-Email-Event-Webhook-Signature": sig, "X-Twilio-Email-Event-Webhook-Timestamp": ts }, payload.trimEnd(), keyB64)).toBe(false);
  });
});

describe("webhook payloads: fixtures typed with the vendors' own TypeScript types", () => {
  it("Resend", () => {
    const p: WebhookEventPayload = { type: "email.bounced", created_at: "2026-09-30T10:00:00.000Z", data: { email_id: "re_1", message_id: "<m@resend>", created_at: "2026-09-30T10:00:00.000Z", from: "a@b.test", to: ["jane@practice.test"], subject: "Hi", bounce: { type: "Permanent", subType: "General", message: "550 no such user" } } };
    expect(parseResend(p)[0]).toMatchObject({ type: "bounced_hard", providerMessageId: "re_1", email: "jane@practice.test", detail: "550 no such user" });
    const c: WebhookEventPayload = { type: "email.complained", created_at: "2026-09-30T10:00:00.000Z", data: { email_id: "re_1", message_id: "m", created_at: "x", from: "a@b.test", to: ["jane@practice.test"], subject: "Hi" } };
    expect(parseResend(c)[0].type).toBe("complained");
  });
  it("Postmark", () => {
    const d: DeliveryWebhook = { RecordType: "Delivery", ServerID: 1, MessageStream: "outbound", MessageID: "pm-1", Recipient: "jane@practice.test", DeliveredAt: "2026-09-30T10:00:00Z", Details: "ok", Metadata: {} };
    expect(parsePostmark(d)[0]).toMatchObject({ type: "delivered", providerMessageId: "pm-1", email: "jane@practice.test" });
    const b: BounceWebhook = { RecordType: "Bounce", ID: 42, Type: "HardBounce", TypeCode: 1, Name: "Hard bounce", MessageID: "pm-1", ServerID: 1, Description: "The server was unable to deliver", Details: "550", Email: "jane@practice.test", From: "s@k.test", BouncedAt: "2026-09-30T10:00:00Z", DumpAvailable: false, Inactive: true, CanActivate: false, Subject: "Hi", MessageStream: "outbound", Metadata: {} };
    expect(parsePostmark(b)[0]).toMatchObject({ type: "bounced_hard", eventId: "b:42" });
    const s: SpamComplaintWebhook = { ...b, RecordType: "SpamComplaint", Type: "SpamComplaint", TypeCode: 100001, Name: "Spam complaint", Metadata: {} };
    expect(parsePostmark(s)[0].type).toBe("complained");
  });
});

describe("outgoing requests: identical on the wire to the vendors' official SDKs", () => {
  const mail = { to: "jane@practice.test", from: "Sam Rivers <sam@kangguircm.test>", subject: "Hello", text: "Plain body", headers: { "List-Unsubscribe": "<https://app.test/api/unsubscribe/t>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };

  it("Resend", async () => {
    captured = [];
    const sdk = new Resend("re_key", ); (sdk as any).baseUrl = base;
    const r = await sdk.emails.send({ from: mail.from, to: [mail.to], subject: mail.subject, text: mail.text, html: "<p>x</p>", headers: mail.headers }, { idempotencyKey: "k1" });
    expect((r as any).data?.id).toBe("re_123");
    const theirs = last();
    await new ResendMailer("re_key", { retryDelaysMs: [] }, base).send({ ...mail, html: "<p>x</p>", idempotencyKey: "k1" });
    const ours = last();
    expect(ours.method).toBe(theirs.method);
    expect(ours.url).toBe(theirs.url);
    expect(ours.headers.authorization).toBe(theirs.headers.authorization);
    expect(ours.headers["idempotency-key"]).toBe(theirs.headers["idempotency-key"]);
    expect(ours.headers["content-type"]).toContain("application/json");
    expect(ours.body).toEqual(theirs.body);
  });

  it("Postmark", async () => {
    captured = [];
    const sdk = new ServerClient("pm-token", { useHttps: false, requestHost: base.replace("http://", "") });
    await sdk.sendEmail({ From: mail.from, To: mail.to, Subject: mail.subject, TextBody: mail.text, HtmlBody: "<p>x</p>", MessageStream: "outbound", TrackOpens: false, TrackLinks: "None" as any, Headers: Object.entries(mail.headers).map(([Name, Value]) => ({ Name, Value })) });
    const theirs = last();
    await new PostmarkMailer("pm-token", "outbound", { retryDelaysMs: [] }, base).send({ ...mail, html: "<p>x</p>" });
    const ours = last();
    expect(ours.method).toBe(theirs.method);
    expect(ours.url).toBe(theirs.url);
    expect(ours.headers["x-postmark-server-token"]).toBe(theirs.headers["x-postmark-server-token"]);
    expect(ours.body).toEqual(theirs.body);
  });

  it("SendGrid", async () => {
    captured = [];
    const client = (sgMail as any).client;
    sgMail.setApiKey("SG.testkey");
    client.setDefaultRequest("baseUrl", base + "/");
    await sgMail.send({ to: mail.to, from: { email: "sam@kangguircm.test", name: "Sam Rivers" }, subject: mail.subject, text: mail.text, html: "<p>x</p>", headers: mail.headers, trackingSettings: { clickTracking: { enable: false }, openTracking: { enable: false } } });
    const theirs = last();
    await new SendGridMailer("SG.testkey", { retryDelaysMs: [] }, base).send({ ...mail, html: "<p>x</p>" });
    const ours = last();
    expect(ours.method).toBe(theirs.method);
    expect(ours.url).toBe(theirs.url);
    expect(ours.headers.authorization).toBe(theirs.headers.authorization);
    // everything the official helper sends must be present and equal in ours (ours adds nothing they don't)
    for (const k of Object.keys(theirs.body)) expect(ours.body[k], `field ${k}`).toEqual(theirs.body[k]);
    for (const k of Object.keys(ours.body)) expect(k in theirs.body, `extra field ${k}`).toBe(true);
  });

  it("OpenAI-format chat completions: same path, auth and message/tool wire shape as the official OpenAI SDK", async () => {
    captured = [];
    const tool = { type: "function" as const, function: { name: "pipeline_stats", description: "d", parameters: { type: "object", properties: {} } } };
    const sdk = new OpenAI({ apiKey: "sk-test", baseURL: `${base}/v1` });
    await sdk.chat.completions.create({ model: "m", messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }], tools: [tool], tool_choice: "auto", max_completion_tokens: 50 });
    const theirs = last();
    await new OpenAICompatLLM({ provider: "openai", apiKey: "sk-test", baseUrl: `${base}/v1`, model: "m", tokenParam: "max_completion_tokens", http: { retryDelaysMs: [] } })
      .converse({ system: "S", messages: [{ role: "user", content: "U" }], tools: [{ name: "pipeline_stats", description: "d", input_schema: { type: "object", properties: {} } }], onTool: async () => "{}", maxTokens: 50 });
    const ours = last();
    expect(ours.url).toBe(theirs.url);
    expect(ours.headers.authorization).toBe(theirs.headers.authorization);
    expect(ours.body).toEqual(theirs.body);
    await new OpenAICompatLLM({ provider: "x", baseUrl: `${base}/v1`, model: "m", http: { retryDelaysMs: [] } }).json({ system: "S", prompt: "p", schema: z.object({}) });
    expect(last().headers.authorization).toBeUndefined();
  });
});
