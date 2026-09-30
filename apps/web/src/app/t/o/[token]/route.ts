import { GIF_1X1, recordOpen } from "@rcm/core";

export const dynamic = "force-dynamic";

/** Open-tracking pixel. Always answers with the same 1x1 GIF (no information leak about whether a token exists). */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  try { await recordOpen(token.replace(/\.gif$/i, ""), req.headers.get("user-agent")); } catch (e) { console.error("[pixel]", (e as Error).message); }
  return new Response(new Uint8Array(GIF_1X1), { headers: { "content-type": "image/gif", "cache-control": "no-store, no-cache, must-revalidate, max-age=0", "content-length": String(GIF_1X1.length) } });
}
