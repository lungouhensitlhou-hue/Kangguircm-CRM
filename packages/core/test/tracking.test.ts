import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "../src/db";
import { enqueueRun } from "../src/queue";
import { processOne } from "../src/agents/worker";
import { addContact, getLead, pipelineStats, setStage, upsertLead } from "../src/leads";
import { isSuppressed } from "../src/compliance";
import { applyEmailEvent, emailStats, openPixelUrl, recordOpen, textToHtml, GIF_1X1 } from "../src/tracking";
import { parseMailgun, parsePostmark, parseResend, parseSendGrid, verifyMailgun, verifyPostmark, verifyResend, verifySendGrid, verifySharedSecret } from "../src/providers/email-events";
import { MailgunMailer, PostmarkMailer, ResendMailer, SendGridMailer } from "../src/providers/mailer";
import { saveSettings } from "../src/settings";
import { makeDeps, readySettings, resetDb, setupDb, teardownDb } from "./helpers";

beforeAll(setupDb);
beforeEach(resetDb);
afterAll(teardownDb);

describe("webhook signature verification", () => {
  it("Resend (Svix): accepts valid, rejects tampered / stale / wrong-secret / missing", () => {
    const secret = "whsec_" + crypto.randomBytes(24).toString("base64");
    const body = JSON.stringify({ type: "email.delivered" });
    const ts = String(Math.floor(Date.now() / 1000));
    const sign = (id: string, t: string, b: string, sec = secret) => "v1," + crypto.createHmac("sha256", Buffer.from(sec.replace("whsec_", ""), "base64")).update(`${id}.${t}.${b}`).digest("base64");
    const h = { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": `v1,bogus ${sign("msg_1", ts, body)}` };
    expect(verifyResend(h, body, secret)).toBe(true);
    expect(verifyResend(h, body + " ", secret)).toBe(false);
    expect(verifyResend(h, body, "whsec_" + crypto.randomBytes(24).toString("base64"))).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifyResend({ "svix-id": "m", "svix-timestamp": old, "svix-signature": sign("m", old, body) }, body, secret)).toBe(false);
    expect(verifyResend({}, body, secret)).toBe(false);
    expect(verifyResend(h, body, "")).toBe(false);
  });

  it("SendGrid (ECDSA): accepts valid, rejects tampered / stale / wrong key", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const body = JSON.stringify([{ event: "delivered" }]);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.sign("sha256", Buffer.from(ts + body), privateKey).toString("base64");
    const h = { "X-Twilio-Email-Event-Webhook-Signature": sig, "X-Twilio-Email-Event-Webhook-Timestamp": ts };
    expect(verifySendGrid(h, body, pubB64)).toBe(true);
    expect(verifySendGrid(h, body.replace("delivered", "bounce"), pubB64)).toBe(false);
    const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    expect(verifySendGrid(h, body, other)).toBe(false);
    expect(verifySendGrid(h, body, "not-a-key")).toBe(false);
    expect(verifySendGrid({ ...h, "X-Twilio-Email-Event-Webhook-Timestamp": String(Number(ts) - 4000) }, body, pubB64)).toBe(false);
  });

  it("Mailgun (HMAC), Postmark (basic auth), shared secret", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac("sha256", "signing-key").update(ts + "tok").digest("hex");
    expect(verifyMailgun({ signature: { timestamp: ts, token: "tok", signature: sig } }, "signing-key")).toBe(true);
    expect(verifyMailgun({ signature: { timestamp: ts, token: "tok2", signature: sig } }, "signing-key")).toBe(false);
    expect(verifyMailgun({ signature: { timestamp: ts, token: "tok", signature: sig } }, "")).toBe(false);
    expect(verifyMailgun({}, "signing-key")).toBe(false);
    const auth = "Basic " + Buffer.from("hook:pw").toString("base64");
    expect(verifyPostmark({ Authorization: auth }, "hook", "pw")).toBe(true);
    expect(verifyPostmark({ Authorization: auth }, "hook", "other")).toBe(false);
    expect(verifyPostmark({}, "hook", "pw")).toBe(false);
    expect(verifySharedSecret("s3", "s3")).toBe(true);
    expect(verifySharedSecret("s3", undefined)).toBe(false);
    expect(verifySharedSecret(null, "s3")).toBe(false);
  });
});

describe("provider payload parsing", () => {
  it("Resend", () => {
    const e = parseResend({ type: "email.bounced", created_at: "2026-09-30T10:00:00Z", data: { email_id: "re_1", to: ["a@b.test"], bounce: { type: "Permanent", message: "mailbox not found" } } }, "evt_1")[0];
    expect(e).toMatchObject({ provider: "resend", type: "bounced_hard", providerMessageId: "re_1", email: "a@b.test", detail: "mailbox not found", eventId: "evt_1" });
    expect(parseResend({ type: "email.bounced", data: { email_id: "x", to: ["a@b.test"], bounce: { type: "Transient" } } })[0].type).toBe("bounced_soft");
    expect(parseResend({ type: "email.complained", data: { email_id: "x", to: ["a@b.test"] } })[0].type).toBe("complained");
    expect(parseResend({ type: "email.sent", data: {} })).toEqual([]);
  });
  it("SendGrid (multiple events, id before the first dot)", () => {
    const evs = parseSendGrid([
      { event: "delivered", email: "a@b.test", sg_message_id: "abc123.filter0001", timestamp: 1790000000, sg_event_id: "e1" },
      { event: "bounce", email: "c@d.test", sg_message_id: "zzz.f", reason: "550 no such user", timestamp: 1790000001, sg_event_id: "e2" },
      { event: "spamreport", email: "c@d.test", sg_message_id: "zzz.f", timestamp: 1790000002, sg_event_id: "e3" },
      { event: "processed", email: "x@y.test" },
    ]);
    expect(evs.map((e) => e.type)).toEqual(["delivered", "bounced_hard", "complained"]);
    expect(evs[0].providerMessageId).toBe("abc123");
    expect(evs[1].detail).toBe("550 no such user");
  });
  it("Postmark", () => {
    expect(parsePostmark({ RecordType: "Delivery", MessageID: "pm-1", Recipient: "a@b.test", DeliveredAt: "2026-09-30T10:00:00Z" })[0]).toMatchObject({ type: "delivered", providerMessageId: "pm-1" });
    expect(parsePostmark({ RecordType: "Bounce", Type: "HardBounce", MessageID: "pm-1", Email: "a@b.test", ID: 9, Description: "bad" })[0]).toMatchObject({ type: "bounced_hard", eventId: "b:9" });
    expect(parsePostmark({ RecordType: "Bounce", Type: "Transient", MessageID: "pm-1", Email: "a@b.test" })[0].type).toBe("bounced_soft");
    expect(parsePostmark({ RecordType: "Bounce", Type: "SpamNotification", MessageID: "pm-1", Email: "a@b.test" })[0].type).toBe("complained");
    expect(parsePostmark({ RecordType: "SpamComplaint", MessageID: "pm-1", Email: "a@b.test" })[0].type).toBe("complained");
  });
  it("Mailgun (message-id without angle brackets)", () => {
    const e = parseMailgun({ "event-data": { event: "failed", severity: "permanent", id: "ev1", timestamp: 1790000000, recipient: "a@b.test", message: { headers: { "message-id": "abc@mg.test" } }, "delivery-status": { message: "550 mailbox unavailable" } } })[0];
    expect(e).toMatchObject({ type: "bounced_hard", providerMessageId: "abc@mg.test", detail: "550 mailbox unavailable" });
    expect(parseMailgun({ "event-data": { event: "failed", severity: "temporary", recipient: "a@b.test", message: { headers: {} } } })[0].type).toBe("bounced_soft");
    expect(parseMailgun({})).toEqual([]);
  });
});

describe("applying delivery events", () => {
  async function sentMessage(providerId = "re_1", email = "jane@practice.test") {
    const { leadId, organizationId } = await upsertLead({ name: "Event Clinic", city: "Austin", state: "TX" });
    await addContact(organizationId, { full_name: "Jane", email, is_decision_maker: true });
    await setStage(leadId, "contacted");
    const m = await queryOne<any>("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, sent_at, provider, provider_message_id, unsub_token) VALUES ($1,'outbound',1,$2,'Hi','b','sent', now() - interval '1 hour','resend',$3,'tok-1') RETURNING *", [leadId, email, providerId]);
    return { leadId, organizationId, msg: m };
  }
  const ev = (over: any) => ({ provider: "resend", type: "delivered", providerMessageId: "re_1", email: "jane@practice.test", eventId: "e-" + Math.random(), ...over });

  it("delivered sets delivered_at; duplicates and unknown messages are ignored", async () => {
    const { msg } = await sentMessage();
    const e = ev({ eventId: "same" });
    expect(await applyEmailEvent(e as any)).toBe("applied");
    expect(await applyEmailEvent(e as any)).toBe("duplicate");
    expect(await applyEmailEvent(ev({ providerMessageId: "nope", email: "ghost@x.test" }) as any)).toBe("unmatched");
    expect((await queryOne<any>("SELECT delivered_at FROM messages WHERE id = $1", [msg.id]))!.delivered_at).not.toBeNull();
    expect((await query("SELECT 1 FROM email_events"))).toHaveLength(1);
  });

  it("hard bounce: contact marked bounced, unsent drafts to that address cancelled, never re-drafted", async () => {
    const { leadId, organizationId } = await sentMessage();
    await query("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status) VALUES ($1,'outbound',2,'jane@practice.test','f','b','draft')", [leadId]);
    expect(await applyEmailEvent(ev({ type: "bounced_hard", detail: "mailbox not found" }) as any)).toBe("applied");
    const c = (await query<any>("SELECT email_status FROM contacts WHERE organization_id = $1", [organizationId]))[0];
    expect(c.email_status).toBe("bounced");
    expect((await queryOne<any>("SELECT status FROM messages WHERE step = 2"))!.status).toBe("cancelled");
    expect((await queryOne<any>("SELECT bounced_at, error FROM messages WHERE step = 1"))).toMatchObject({ error: "bounced: mailbox not found" });
    await enqueueRun({ kind: "outreach", leadId, input: { step: 2 } });
    await readySettings();
    await processOne("t", makeDeps());
    expect(await query("SELECT 1 FROM messages WHERE step = 2 AND status = 'draft'")).toHaveLength(0); // no reachable contact left
  });

  it("soft bounce is logged only; spam complaint suppresses and disqualifies; provider opens are not counted", async () => {
    const { leadId, msg } = await sentMessage();
    await applyEmailEvent(ev({ type: "bounced_soft", detail: "mailbox full" }) as any);
    expect((await queryOne<any>("SELECT bounced_at FROM messages WHERE id = $1", [msg.id]))!.bounced_at).toBeNull();
    await applyEmailEvent(ev({ type: "opened" }) as any);
    expect((await queryOne<any>("SELECT open_count FROM messages WHERE id = $1", [msg.id]))!.open_count).toBe(0);
    await applyEmailEvent(ev({ type: "complained" }) as any);
    expect(await isSuppressed("jane@practice.test")).toBe(true);
    expect((await getLead(leadId))!.stage).toBe("disqualified");
    expect(await query("SELECT 1 FROM audit_log WHERE action = 'spam_complaint'")).toHaveLength(1);
  });

  it("falls back to matching by recipient when the provider id is unknown (recent sends only)", async () => {
    const { msg } = await sentMessage("something-else");
    expect(await applyEmailEvent(ev({ providerMessageId: "unknown-id" }) as any)).toBe("applied");
    expect((await queryOne<any>("SELECT delivered_at FROM messages WHERE id = $1", [msg.id]))!.delivered_at).not.toBeNull();
  });

  it("Mailgun-style ids with angle brackets still match", async () => {
    const { msg } = await sentMessage("<abc@mg.test>");
    expect(await applyEmailEvent(ev({ provider: "mailgun", providerMessageId: "abc@mg.test", email: null }) as any)).toBe("applied");
    expect((await queryOne<any>("SELECT delivered_at FROM messages WHERE id = $1", [msg.id]))!.delivered_at).not.toBeNull();
  });
});

describe("self-hosted open tracking", () => {
  async function msg(sentAgoSec: number) {
    const { leadId } = await upsertLead({ name: "Pixel Clinic" });
    return queryOne<any>("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, sent_at, unsub_token) VALUES ($1,'outbound',1,'a@b.test','s','b','sent', now() - ($2 || ' seconds')::interval, $3) RETURNING *", [leadId, String(sentAgoSec), "tok-" + Math.random()]);
  }
  const UA = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Mail";

  it("counts real opens, rejects instant scanner opens and bot user agents, throttles repeats", async () => {
    const m = await msg(600);
    expect(await recordOpen("nope", UA)).toBe("unknown");
    expect(await recordOpen(m.unsub_token, "Mozilla/5.0 (compatible; Proofpoint URL Defense)")).toBe("suspected-bot");
    expect(await recordOpen(m.unsub_token, null)).toBe("ignored"); // same kind within the 60s throttle window
    expect(await recordOpen(m.unsub_token, UA)).toBe("counted"); // a real open right after a scan is NOT swallowed
    await query("UPDATE email_events SET created_at = now() - interval '5 minutes'");
    expect(await recordOpen(m.unsub_token, UA)).toBe("counted");
    expect(await recordOpen(m.unsub_token, UA)).toBe("ignored");
    await query("UPDATE email_events SET created_at = now() - interval '5 minutes'");
    expect(await recordOpen(m.unsub_token, UA)).toBe("counted");
    const row = (await queryOne<any>("SELECT open_count, first_opened_at FROM messages WHERE id = $1", [m.id]))!;
    expect(row.open_count).toBe(3);
    expect(row.first_opened_at).not.toBeNull();
    const fresh = await msg(3); // opened 3 seconds after sending: an automatic scan, not a person
    expect(await recordOpen(fresh.unsub_token, UA)).toBe("suspected-bot");
    expect((await queryOne<any>("SELECT open_count FROM messages WHERE id = $1", [fresh.id]))!.open_count).toBe(0);
    const stats = await emailStats();
    expect(stats.opened).toBe(1);
    expect((await pipelineStats()).email.opened).toBe(1);
  });

  it("pixel + html twin", () => {
    expect(GIF_1X1.subarray(0, 6).toString()).toBe("GIF89a");
    const html = textToHtml("Hi <b>Jane</b> & co,\n\nSee https://x.test/a?b=1&c=2\nline two", "http://app.test/t/o/abc.gif");
    expect(html).toContain("&lt;b&gt;Jane&lt;/b&gt; &amp; co,");
    expect(html).toContain('<a href="https://x.test/a?b=1&amp;c=2">');
    expect(html).toContain("<br>line two");
    expect(html).toContain('<img src="http://app.test/t/o/abc.gif" width="1" height="1"');
    expect(textToHtml("plain")).not.toContain("<img");
    expect(openPixelUrl("tok")).toBe("http://app.test/t/o/tok.gif");
  });

  it("send only attaches the HTML pixel version when tracking is turned on", async () => {
    const run = async (track: boolean) => {
      await resetDb();
      await readySettings({ sendWindowStartHour: 0, sendWindowEndHour: 24, sendOnWeekends: true, trackOpens: track });
      const { leadId } = await upsertLead({ name: "Send Clinic" });
      const m = await queryOne<any>("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, unsub_token) VALUES ($1,'outbound',1,'a@b.test','s','Hello there\n\n--\nfooter','approved','utok') RETURNING id", [leadId]);
      await enqueueRun({ kind: "send", input: { messageId: m.id } });
      const deps = makeDeps();
      await processOne("t", deps);
      return deps.mailer.outbox[0];
    };
    const off = await run(false);
    expect(off.html).toBeUndefined();
    const on = await run(true);
    expect(on.html).toContain("http://app.test/t/o/utok.gif");
    expect(on.text).not.toContain("/t/o/");
  });
});

describe("mailers send the HTML twin without turning on provider-side tracking", () => {
  const mail = { to: "j@p.test", from: "Sam <s@k.test>", subject: "Hi", text: "T", html: "<p>H</p>", headers: {} };
  const capture = () => { const calls: any[] = []; const f = (async (u: string, i: any) => { calls.push({ u, i, b: (() => { try { return JSON.parse(i.body); } catch { return i.body; } })() }); return new Response(JSON.stringify({ id: "x", MessageID: "y" }), { status: 200, headers: { "x-message-id": "z" } }); }) as any; return { calls, f }; };
  it("all providers", async () => {
    let c = capture(); await new ResendMailer("k", { fetchImpl: c.f, retryDelaysMs: [] }).send(mail); expect(c.calls[0].b.html).toBe("<p>H</p>");
    c = capture(); await new SendGridMailer("k", { fetchImpl: c.f, retryDelaysMs: [] }).send(mail); expect(c.calls[0].b.content.map((x: any) => x.type)).toEqual(["text/plain", "text/html"]); expect(c.calls[0].b.tracking_settings.open_tracking.enable).toBe(false);
    c = capture(); await new PostmarkMailer("k", "outbound", { fetchImpl: c.f, retryDelaysMs: [] }).send(mail); expect(c.calls[0].b.HtmlBody).toBe("<p>H</p>"); expect(c.calls[0].b.TrackOpens).toBe(false);
    c = capture(); await new MailgunMailer("k", "d.test", "us", c.f).send(mail); const f = new URLSearchParams(c.calls[0].b); expect(f.get("html")).toBe("<p>H</p>"); expect(f.get("o:tracking")).toBe("no");
    c = capture(); await new ResendMailer("k", { fetchImpl: c.f, retryDelaysMs: [] }).send({ ...mail, html: undefined }); expect("html" in c.calls[0].b).toBe(false);
  });
});

describe("settings", () => {
  it("trackOpens defaults to off", async () => {
    const s = await saveSettings({});
    expect(s.trackOpens).toBe(false);
  });
});
