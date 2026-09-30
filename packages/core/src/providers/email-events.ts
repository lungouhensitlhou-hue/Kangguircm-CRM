import crypto from "node:crypto";

export type EventType = "delivered" | "bounced_hard" | "bounced_soft" | "complained" | "opened" | "clicked" | "deferred";
export interface NormalizedEvent {
  provider: string;
  type: EventType;
  providerMessageId: string | null;
  email: string | null;
  detail?: string;
  at?: Date;
  eventId?: string | null;
}

type Headers = Record<string, string | undefined>;
const lower = (h: Headers) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const safeEq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const FIVE_MIN = 5 * 60_000;
const SENDGRID_TOLERANCE = 25 * 3600_000; // SendGrid retries failed deliveries for up to 24h; events are idempotent, so replays are harmless

/** Svix-style signature used by Resend webhooks: HMAC-SHA256 over "<id>.<timestamp>.<body>" with the base64 secret after "whsec_". */
export function verifyResend(headers: Headers, rawBody: string, secret: string, now = Date.now()): boolean {
  const h = lower(headers);
  const id = h["svix-id"], ts = h["svix-timestamp"], sigs = h["svix-signature"];
  if (!id || !ts || !sigs || !secret) return false;
  if (Math.abs(now - Number(ts) * 1000) > FIVE_MIN) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
  return sigs.split(" ").some((s) => { const [v, sig] = s.split(","); return v === "v1" && !!sig && safeEq(sig, expected); });
}

/** SendGrid signed event webhook: ECDSA (P-256/SHA-256) over timestamp+body; publicKey is the base64 SPKI DER key shown in SendGrid. */
export function verifySendGrid(headers: Headers, rawBody: string, publicKeyB64: string, now = Date.now()): boolean {
  const h = lower(headers);
  const sig = h["x-twilio-email-event-webhook-signature"], ts = h["x-twilio-email-event-webhook-timestamp"];
  if (!sig || !ts || !publicKeyB64) return false;
  if (Math.abs(now - Number(ts) * 1000) > SENDGRID_TOLERANCE) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return crypto.verify("sha256", Buffer.from(ts + rawBody), key, Buffer.from(sig, "base64"));
  } catch { return false; }
}

/** Mailgun: body.signature = { timestamp, token, signature }, signature = HMAC-SHA256(signingKey, timestamp+token) hex. */
export function verifyMailgun(body: any, signingKey: string, now = Date.now()): boolean {
  const s = body?.signature;
  if (!s?.timestamp || !s?.token || !s?.signature || !signingKey) return false;
  if (Math.abs(now - Number(s.timestamp) * 1000) > FIVE_MIN) return false;
  const expected = crypto.createHmac("sha256", signingKey).update(String(s.timestamp) + String(s.token)).digest("hex");
  return safeEq(String(s.signature), expected);
}

const seenTokens = new Map<string, number>();
/**
 * Mailgun's signature covers only timestamp+token, not the body, so a captured request could be replayed with a different
 * payload. Each token may be used once (in-memory per instance, kept 15 min: longer than the 5 min timestamp tolerance).
 */
export function isReplayedMailgunToken(body: any, now = Date.now()): boolean {
  const token = body?.signature?.token;
  if (!token) return true;
  for (const [t, at] of seenTokens) if (now - at > 15 * 60_000) seenTokens.delete(t);
  if (seenTokens.has(token)) return true;
  seenTokens.set(token, now);
  return false;
}

/** Postmark authenticates webhooks with HTTP Basic credentials that you put in the webhook URL. */
export function verifyPostmark(headers: Headers, user: string, pass: string): boolean {
  const auth = lower(headers).authorization;
  if (!auth?.startsWith("Basic ") || !user || !pass) return false;
  return safeEq(Buffer.from(auth.slice(6), "base64").toString(), `${user}:${pass}`);
}

/** Fallback for any provider/relay: a shared secret in the x-webhook-secret header or ?secret= query. */
export function verifySharedSecret(given: string | null | undefined, secret: string | undefined): boolean {
  return !!secret && !!given && safeEq(given, secret);
}

const strip = (id: unknown) => (id == null ? null : String(id).replace(/^<|>$/g, ""));
const when = (v: unknown, unit: "s" | "iso" = "iso") => { if (v == null) return undefined; const d = unit === "s" ? new Date(Number(v) * 1000) : new Date(String(v)); return isNaN(d.getTime()) ? undefined : d; };

export function parseResend(body: any, eventId?: string | null): NormalizedEvent[] {
  const t = String(body?.type ?? "");
  const d = body?.data ?? {};
  const base = { provider: "resend", providerMessageId: strip(d.email_id), email: Array.isArray(d.to) ? String(d.to[0] ?? "") || null : (d.to ?? null), at: when(body?.created_at ?? d.created_at), eventId };
  switch (t) {
    case "email.delivered": return [{ ...base, type: "delivered" }];
    // bounce.type is Permanent | Transient | Undetermined: only a Permanent bounce proves the address is bad.
    case "email.bounced": return [{ ...base, type: /permanent/i.test(d.bounce?.type ?? "") ? "bounced_hard" : "bounced_soft", detail: d.bounce?.message ?? d.bounce?.type }];
    // Resend refused to send because the address is on its suppression list (earlier bounce/complaint): treat as unreachable.
    case "email.suppressed": return [{ ...base, type: "bounced_hard", detail: d.suppressed?.message ?? "address suppressed by provider" }];
    case "email.failed": return [{ ...base, type: "bounced_soft", detail: d.failed?.reason ?? "send failed" }];
    case "email.complained": return [{ ...base, type: "complained" }];
    case "email.delivery_delayed": return [{ ...base, type: "deferred" }];
    case "email.opened": return [{ ...base, type: "opened" }];
    case "email.clicked": return [{ ...base, type: "clicked" }];
    default: return [];
  }
}

export function parseSendGrid(body: any): NormalizedEvent[] {
  const arr: any[] = Array.isArray(body) ? body : [];
  const out: NormalizedEvent[] = [];
  for (const e of arr) {
    const base = { provider: "sendgrid", providerMessageId: strip(String(e.sg_message_id ?? "").split(".")[0]) || null, email: e.email ?? null, at: when(e.timestamp, "s"), eventId: e.sg_event_id ?? null, detail: e.reason ?? e.response };
    switch (e.event) {
      case "delivered": out.push({ ...base, type: "delivered" }); break;
      case "bounce": out.push({ ...base, type: "bounced_hard" }); break;
      case "dropped": out.push({ ...base, type: /bounce|invalid|spam/i.test(e.reason ?? "") ? "bounced_hard" : "bounced_soft" }); break;
      case "deferred": out.push({ ...base, type: "deferred" }); break;
      case "spamreport": out.push({ ...base, type: "complained" }); break;
      case "unsubscribe": case "group_unsubscribe": out.push({ ...base, type: "complained", detail: "recipient unsubscribed" }); break;
      case "open": out.push({ ...base, type: "opened" }); break;
      case "click": out.push({ ...base, type: "clicked" }); break;
    }
  }
  return out;
}

// Only these prove the address is bad. Blocked / DnsError / Transient / SoftBounce / AutoResponder say nothing about the mailbox itself.
const PM_HARD = /^(HardBounce|BadEmailAddress|ManuallyDeactivated)$/;
const PM_OPTOUT = /^(SpamNotification|SpamComplaint|Unsubscribe)$/;
export function parsePostmark(body: any): NormalizedEvent[] {
  const rt = body?.RecordType;
  const base = { provider: "postmark", providerMessageId: strip(body?.MessageID), email: body?.Recipient ?? body?.Email ?? null };
  if (rt === "Delivery") return [{ ...base, type: "delivered", at: when(body.DeliveredAt), eventId: `d:${body.MessageID}` }];
  if (rt === "Bounce") {
    const t = String(body.Type ?? "");
    return [{ ...base, type: PM_OPTOUT.test(t) ? "complained" : PM_HARD.test(t) ? "bounced_hard" : "bounced_soft", detail: body.Description ?? t, at: when(body.BouncedAt), eventId: body.ID != null ? `b:${body.ID}` : null }];
  }
  if (rt === "SpamComplaint") return [{ ...base, type: "complained", at: when(body.BouncedAt), eventId: body.ID != null ? `s:${body.ID}` : null }];
  if (rt === "Open") return [{ ...base, type: "opened", at: when(body.ReceivedAt) }];
  if (rt === "Click") return [{ ...base, type: "clicked", at: when(body.ReceivedAt) }];
  return [];
}

export function parseMailgun(body: any): NormalizedEvent[] {
  const e = body?.["event-data"];
  if (!e) return [];
  const base = { provider: "mailgun", providerMessageId: strip(e.message?.headers?.["message-id"]), email: e.recipient ?? null, at: when(e.timestamp, "s"), eventId: e.id ?? null, detail: e["delivery-status"]?.message ?? e.reason };
  switch (e.event) {
    case "delivered": return [{ ...base, type: "delivered" }];
    case "failed": return [{ ...base, type: e.severity === "permanent" ? "bounced_hard" : "bounced_soft" }];
    case "complained": return [{ ...base, type: "complained" }];
    case "unsubscribed": return [{ ...base, type: "complained", detail: "recipient unsubscribed" }];
    // "rejected" = Mailgun refused to send; only a previously-bounced address makes that a hard failure.
    case "rejected": return [{ ...base, type: /bounce|suppress/i.test(e.reject?.reason ?? e.reason ?? "") ? "bounced_hard" : "bounced_soft", detail: e.reject?.reason ?? e.reason }];
    case "opened": return [{ ...base, type: "opened" }];
    case "clicked": return [{ ...base, type: "clicked" }];
    default: return [];
  }
}

export const EMAIL_EVENT_PROVIDERS = ["resend", "sendgrid", "postmark", "mailgun"] as const;
