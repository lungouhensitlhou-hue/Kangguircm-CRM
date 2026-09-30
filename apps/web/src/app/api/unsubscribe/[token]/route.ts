import { NextResponse } from "next/server";
import { unsubscribeByToken } from "@rcm/core";
import { route } from "@/lib/api";

export const dynamic = "force-dynamic";

// RFC 8058 one-click: mail clients POST here directly.
export const POST = route<{ token: string }>(async (_req, { params }) => {
  const r = await unsubscribeByToken(params.token);
  return NextResponse.json({ ok: r.ok }, { status: r.ok ? 200 : 404 });
}, { public: true });

// Humans (or scanners) hitting the URL are sent to the confirmation page; GET never unsubscribes on its own.
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return NextResponse.redirect(new URL(`/unsubscribe/${encodeURIComponent(token)}`, req.url), 303);
}
