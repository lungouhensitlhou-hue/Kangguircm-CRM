import { z } from "zod";
import { normalizeEmail, query, suppress } from "@rcm/core";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route(async () => ({ suppressions: await query("SELECT email, reason, created_at FROM suppressions ORDER BY created_at DESC LIMIT 500") }));
export const POST = route(async (req) => {
  const { email } = z.object({ email: z.string().min(3).max(254) }).parse(await body(req));
  await suppress(email, "manual");
  return { ok: true };
});
export const DELETE = route(async (req) => {
  const { email } = z.object({ email: z.string().min(3).max(254) }).parse(await body(req));
  await query("DELETE FROM suppressions WHERE email = $1", [normalizeEmail(email)]);
  return { ok: true };
});
