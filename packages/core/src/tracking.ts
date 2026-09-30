import { query, queryOne } from "./db";
import { audit } from "./settings";
import { baseUrl, normalizeEmail, suppress } from "./compliance";
import type { NormalizedEvent } from "./providers/email-events";

export function openPixelUrl(token: string): string {
  return `${baseUrl()}/t/o/${token}.gif`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Minimal HTML twin of a plain-text email (paragraphs, auto-linked URLs) plus an optional 1px open pixel. */
export function textToHtml(text: string, pixelUrl?: string): string {
  const paras = text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${esc(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, "<br>")}</p>`)
    .join("");
  const pixel = pixelUrl ? `<img src="${esc(pixelUrl)}" width="1" height="1" alt="" style="display:none;border:0">` : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${paras}${pixel}</div>`;
}

export const GIF_1X1 = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const BOT_UA = /(proofpoint|barracuda|mimecast|safelinks|forcepoint|symantec|trend ?micro|mcafee|cisco|bot\b|crawler|scanner|spider|curl|wget|python|java\/|go-http|headless|monitor)/i;

/**
 * Count an open from the tracking pixel. Opens within OPEN_BOT_WINDOW_SEC (default 20) of sending, or from known
 * scanner user agents, are recorded as "suspected-bot" and NOT counted. Repeat hits within a minute are ignored.
 */
export async function recordOpen(token: string, ua: string | null, now = new Date()): Promise<"counted" | "suspected-bot" | "ignored" | "unknown"> {
  const m = await queryOne<{ id: string; sent_at: string | null; to_email: string | null }>(
    "SELECT id, sent_at, to_email FROM messages WHERE unsub_token = $1 AND direction = 'outbound' AND status = 'sent'",
    [token],
  );
  if (!m) return "unknown";
  const windowSec = Number(process.env.OPEN_BOT_WINDOW_SEC ?? 20);
  const tooSoon = !m.sent_at || now.getTime() - new Date(m.sent_at).getTime() < windowSec * 1000;
  const suspect = tooSoon || !ua || BOT_UA.test(ua);
  // Throttle repeats of the same kind only, so a scanner hit never swallows the person's real open moments later.
  const kind = suspect ? "suspected-bot" : "ok";
  const recent = await queryOne("SELECT 1 FROM email_events WHERE message_id = $1 AND type = 'opened' AND provider = 'pixel' AND detail = $3 AND created_at > $2", [m.id, new Date(now.getTime() - 60_000), kind]);
  if (recent) return "ignored";
  await query("INSERT INTO email_events (message_id, provider, type, email, detail, meta) VALUES ($1,'pixel','opened',$2,$3,$4::jsonb)", [
    m.id, m.to_email, kind, JSON.stringify({ ua: (ua ?? "").slice(0, 200) }),
  ]);
  if (suspect) return "suspected-bot";
  await query("UPDATE messages SET open_count = open_count + 1, first_opened_at = COALESCE(first_opened_at, $2) WHERE id = $1", [m.id, now]);
  return "counted";
}

/**
 * Apply a provider delivery event. Hard bounces mark the contact bounced (never emailed again) and cancel unsent drafts;
 * spam complaints suppress the address and disqualify the lead. Provider open/click events are logged but not counted
 * (opens come only from the self-hosted pixel, to avoid double counting).
 */
export async function applyEmailEvent(ev: NormalizedEvent): Promise<"applied" | "duplicate" | "unmatched"> {
  const pid = ev.providerMessageId;
  let msg = pid ? await queryOne<{ id: string; lead_id: string; to_email: string | null }>("SELECT id, lead_id, to_email FROM messages WHERE trim(both '<>' from provider_message_id) = $1 AND direction = 'outbound'", [pid]) : null;
  if (!msg && ev.email) {
    msg = await queryOne("SELECT id, lead_id, to_email FROM messages WHERE lower(to_email) = $1 AND direction = 'outbound' AND status = 'sent' AND sent_at > now() - interval '14 days' ORDER BY sent_at DESC LIMIT 1", [normalizeEmail(ev.email)]);
  }
  if (!msg) return "unmatched";
  const at = ev.at ?? new Date();
  const key = `${ev.provider}:${ev.eventId ?? `${pid}:${ev.type}:${at.toISOString()}`}`;
  const ins = await queryOne("INSERT INTO email_events (message_id, provider, type, email, detail, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id", [msg.id, ev.provider, ev.type, ev.email ?? msg.to_email, (ev.detail ?? "").slice(0, 500), key]);
  if (!ins) return "duplicate";
  const email = normalizeEmail(ev.email ?? msg.to_email ?? "");
  switch (ev.type) {
    case "delivered":
      await query("UPDATE messages SET delivered_at = COALESCE(delivered_at, $2) WHERE id = $1", [msg.id, at]);
      break;
    case "bounced_hard":
      await query("UPDATE messages SET bounced_at = COALESCE(bounced_at, $2), error = $3 WHERE id = $1", [msg.id, at, `bounced: ${ev.detail ?? "address rejected"}`.slice(0, 300)]);
      if (email) {
        await query("UPDATE contacts SET email_status = 'bounced' WHERE lower(email) = $1", [email]);
        await query("UPDATE messages SET status = 'cancelled', error = 'address bounced' WHERE lower(to_email) = $1 AND direction = 'outbound' AND status IN ('draft','approved')", [email]);
      }
      break;
    case "complained":
      if (email) await suppress(email, "spam-complaint");
      await query("UPDATE leads SET stage = 'disqualified', updated_at = now() WHERE id = $1", [msg.lead_id]);
      await audit("provider", "spam_complaint", "message", msg.id, { email });
      break;
    default: // bounced_soft, deferred, opened, clicked: logged only
  }
  return "applied";
}

export async function emailStats() {
  return (await queryOne<{ delivered: number; bounced: number; opened: number; complaints: number }>(
    `SELECT count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
            count(*) FILTER (WHERE bounced_at IS NOT NULL)::int AS bounced,
            count(*) FILTER (WHERE open_count > 0)::int AS opened,
            (SELECT count(*) FROM suppressions WHERE reason = 'spam-complaint')::int AS complaints
     FROM messages WHERE direction = 'outbound' AND status = 'sent'`,
  ))!;
}
