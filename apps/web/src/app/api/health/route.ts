import { query } from "@rcm/core";
import { route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route(async () => {
  await query("SELECT 1");
  return { ok: true, time: new Date().toISOString() };
}, { public: true });
