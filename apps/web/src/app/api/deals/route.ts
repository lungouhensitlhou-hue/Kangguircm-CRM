import { z } from "zod";
import { createDeal, dealStats, listDeals } from "@rcm/core";
import { body, json, route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route(async (req) => {
  const p = new URL(req.url).searchParams;
  return { deals: await listDeals({ status: (p.get("status") as any) ?? undefined, leadId: p.get("leadId") ?? undefined }), stats: await dealStats() };
});
const Create = z.object({ leadId: z.string().uuid(), name: z.string().max(200).optional(), valueUsd: z.number().min(0).max(1e9).optional(), expectedClose: z.string().nullable().optional(), notes: z.string().max(2000).optional() });
export const POST = route(async (req) => json(await createDeal(Create.parse(await body(req))), 201));
