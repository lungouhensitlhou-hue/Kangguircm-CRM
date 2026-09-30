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
  if (Math.abs(now - Number(ts) * 1000) > FIVE_MIN) return false;
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
    case "email.bounced": return [{ ...base, type: /transient/i.test(d.bounce?.type ?? "") ? "bounced_soft" : "bounced_hard", detail: d.bounce?.message ?? d.bounce?.type }];
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
      case "open": out.push({ ...base, type: "opened" }); break;
      case "click": out.push({ ...base, type: "clicked" }); break;
    }
  }
  return out;
}

const PM_HARD = /^(HardBounce|BadEmailAddress|ManuallyDeactivated|DnsError|Blocked)$/;
export function parsePostmark(body: any): NormalizedEvent[] {
  const rt = body?.RecordType;
  const base = { provider: "postmark", providerMessageId: strip(body?.MessageID), email: body?.Recipient ?? body?.Email ?? null };
  if (rt === "Delivery") return [{ ...base, type: "delivered", at: when(body.DeliveredAt), eventId: `d:${body.MessageID}` }];
  if (rt === "Bounce") {
    const t = String(body.Type ?? "");
    return [{ ...base, type: t === "SpamNotification" ? "complained" : PM_HARD.test(t) ? "bounced_hard" : "bounced_soft", detail: body.Description ?? t, at: when(body.BouncedAt), eventId: body.ID != null ? `b:${body.ID}` : null }];
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
    case "opened": return [{ ...base, type: "opened" }];
    case "clicked": return [{ ...base, type: "clicked" }];
    default: return [];
  }
}

export const EMAIL_EVENT_PROVIDERS = ["resend", "sendgrid", "postmark", "mailgun"] as const;
