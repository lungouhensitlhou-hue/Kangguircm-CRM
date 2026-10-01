import { audit, exportLeadsCsv } from "@rcm/core";
import { route } from "@/lib/api";

export const dynamic = "force-dynamic";

/** CSV of the leads matching the same filters as the Leads page (?q&stage&state&specialty&tag&minScore). */
export const GET = route(async (req, { user }) => {
  const p = new URL(req.url).searchParams;
  const csv = await exportLeadsCsv({ q: p.get("q") ?? undefined, stage: p.get("stage") ?? undefined, state: p.get("state") ?? undefined, specialty: p.get("specialty") ?? undefined, tag: p.get("tag") ?? undefined, minScore: p.get("minScore") ? Number(p.get("minScore")) : undefined, sort: (p.get("sort") as any) ?? undefined });
  await audit(user!.email, "export_leads", "leads", undefined, { rows: csv.split("\r\n").length - 2 });
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
});
