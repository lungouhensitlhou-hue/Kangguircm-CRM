import { NextResponse } from "next/server";
import { applyEmailEvent, isReplayedMailgunToken, parseMailgun, parsePostmark, parseResend, parseSendGrid, verifyMailgun, verifyPostmark, verifyResend, verifySendGrid, verifySharedSecret, type NormalizedEvent } from "@rcm/core";

export const dynamic = "force-dynamic";
const env = (k: string) => process.env[k]?.trim() ?? "";

/**
 * Delivery events from your email provider: delivered, bounced, spam complaints.
 * Point the provider's webhook at  {APP_BASE_URL}/api/webhooks/email/<resend|sendgrid|postmark|mailgun>
 * Every request must authenticate (provider-native signature, or EMAIL_WEBHOOK_SECRET); otherwise it is rejected.
 */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const raw = await req.text();
  if (raw.length > 2_000_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  const headers = Object.fromEntries(req.headers.entries());
  const url = new URL(req.url);
  let body: any;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const shared = verifySharedSecret(headers["x-webhook-secret"] ?? url.searchParams.get("secret"), env("EMAIL_WEBHOOK_SECRET"));
  let ok = shared;
  let events: NormalizedEvent[] = [];
  switch (provider) {
    case "resend": ok ||= verifyResend(headers, raw, env("RESEND_WEBHOOK_SECRET")); events = parseResend(body, headers["svix-id"]); break;
    case "sendgrid": ok ||= verifySendGrid(headers, raw, env("SENDGRID_WEBHOOK_PUBLIC_KEY")); events = parseSendGrid(body); break;
    case "postmark": ok ||= verifyPostmark(headers, env("POSTMARK_WEBHOOK_USER"), env("POSTMARK_WEBHOOK_PASSWORD")); events = parsePostmark(body); break;
    case "mailgun": {
      // Mailgun's signature does not cover the body, so each signed token is accepted only once.
      const native = !shared && verifyMailgun(body, env("MAILGUN_WEBHOOK_SIGNING_KEY"));
      if (native && isReplayedMailgunToken(body)) return NextResponse.json({ ok: true, replay: true });
      ok ||= native; events = parseMailgun(body); break;
    }
    default: return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }
  if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  const result = { applied: 0, duplicate: 0, unmatched: 0 };
  for (const e of events) result[await applyEmailEvent(e)]++;
  return NextResponse.json({ ok: true, ...result });
}
