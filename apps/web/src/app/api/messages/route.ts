import { listMessages } from "@rcm/core";
import { route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route(async (req) => {
  const p = new URL(req.url).searchParams;
  return { messages: await listMessages({ status: p.get("status") ?? undefined, leadId: p.get("leadId") ?? undefined, limit: Number(p.get("limit") ?? 100) }) };
});
