import crypto from "node:crypto";
import { z } from "zod";
import { recordInbound } from "@rcm/core";
import { HttpError, body, route } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Webhook for inbound replies (Postmark/SendGrid/Mailgun parse hooks, or your own IMAP bridge). Shared-secret protected. */
export const POST = route(async (req) => {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  const given = req.headers.get("x-webhook-secret") ?? "";
  const ok = !!secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) throw new HttpError(401, "Invalid webhook secret");
  const b = z.object({ from: z.string().min(3).max(320), subject: z.string().max(500).optional(), body: z.string().max(50000) }).parse(await body(req));
  return recordInbound(b);
}, { public: true });
