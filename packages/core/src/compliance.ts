import crypto from "node:crypto";
import { query, queryOne } from "./db";
import type { Settings } from "./settings";

export function normalizeEmail(e: string): string {
  return e.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]{2,}$/;
export function isValidEmail(e: string | null | undefined): e is string {
  return !!e && EMAIL_RE.test(e.trim()) && e.length <= 254;
}

/** Role/shared inboxes that are fine for B2B practice-manager outreach, but low signal. */
export function isGenericMailbox(email: string): boolean {
  return /^(info|contact|office|admin|hello|support|billing|frontdesk|reception|appointments|scheduling)@/i.test(email);
}

export async function isSuppressed(email: string): Promise<boolean> {
  const e = normalizeEmail(email);
  const domain = e.split("@")[1];
  const row = await queryOne(
    "SELECT 1 FROM suppressions WHERE email = $1 OR email = $2 LIMIT 1",
    [e, domain ? `@${domain}` : e],
  );
  return !!row;
}

/** Add to the do-not-contact list and cancel any unsent drafts to that address. */
export async function suppress(email: string, reason = "unsubscribe"): Promise<void> {
  const e = normalizeEmail(email);
  await query("INSERT INTO suppressions (email, reason) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING", [e, reason]);
  await query(
    `UPDATE messages SET status = 'cancelled', error = 'recipient suppressed'
     WHERE lower(to_email) = $1 AND direction = 'outbound' AND status IN ('draft','approved')`,
    [e],
  );
}

export function newUnsubToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function baseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function unsubscribeUrl(token: string): string {
  return `${baseUrl()}/unsubscribe/${token}`;
}

/** RFC 8058 one-click endpoint for the List-Unsubscribe header (accepts POST without a browser). */
export function unsubscribeApiUrl(token: string): string {
  return `${baseUrl()}/api/unsubscribe/${token}`;
}

/** CAN-SPAM footer: identifies the sender, gives a physical address and a working opt-out. */
export function complianceFooter(s: Settings, token: string): string {
  const lines = [
    "--",
    `${s.senderName}, ${s.companyName}`,
    s.physicalAddress || "[Set your physical mailing address in Settings before sending]",
    `Not interested? Unsubscribe here: ${unsubscribeUrl(token)}`,
  ];
  return lines.join("\n");
}

export function assembleBody(body: string, s: Settings, token: string): string {
  const clean = body.replace(/\n--\n[\s\S]*$/, "").trimEnd();
  return `${clean}\n\n${complianceFooter(s, token)}`;
}

/** True when the sender identity needed to legally send is configured. */
export function senderReady(s: Settings): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!s.physicalAddress.trim()) missing.push("physical mailing address");
  if (!s.senderEmail.trim()) missing.push("sender email");
  if (!s.senderName.trim()) missing.push("sender name");
  return { ok: missing.length === 0, missing };
}

function partsInTz(now: Date, tz: string): { hour: number; weekday: string } {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false, weekday: "short" });
  const p = fmt.formatToParts(now);
  const hour = parseInt(p.find((x) => x.type === "hour")!.value, 10) % 24;
  return { hour, weekday: p.find((x) => x.type === "weekday")!.value };
}

type Window = Pick<Settings, "timezone" | "sendWindowStartHour" | "sendWindowEndHour"> & { sendOnWeekends?: boolean };

export function isWithinSendWindow(now: Date, s: Window): boolean {
  const { hour, weekday } = partsInTz(now, s.timezone);
  if (!s.sendOnWeekends && (weekday === "Sat" || weekday === "Sun")) return false;
  return hour >= s.sendWindowStartHour && hour < s.sendWindowEndHour;
}

/** Next instant (15-min granularity) inside the send window, for rescheduling. */
export function nextSendWindow(now: Date, s: Window): Date {
  const t = new Date(now.getTime());
  for (let i = 0; i < 4 * 24 * 8; i++) {
    t.setTime(t.getTime() + 15 * 60_000);
    if (isWithinSendWindow(t, s)) return t;
  }
  return new Date(now.getTime() + 3600_000);
}

export async function sentToday(): Promise<number> {
  const row = await queryOne<{ n: number }>(
    "SELECT count(*)::int AS n FROM messages WHERE direction = 'outbound' AND status = 'sent' AND sent_at >= now() - interval '24 hours'",
  );
  return row?.n ?? 0;
}

const UNSUB_INTENT = /\b(unsubscribe|remove me|stop (emailing|contacting|sending)|do not (contact|email)|take me off|opt[- ]?out)\b/i;
export function hasUnsubscribeIntent(text: string): boolean {
  return UNSUB_INTENT.test(text);
}
