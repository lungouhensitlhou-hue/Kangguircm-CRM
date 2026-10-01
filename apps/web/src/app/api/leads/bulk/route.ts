import { z } from "zod";
import { enqueueRun, setStage, STAGES } from "@rcm/core";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";
const Bulk = z.object({ ids: z.array(z.string().uuid()).min(1).max(500), action: z.enum(["research", "draft_outreach", "find_contacts", "stage"]), stage: z.enum(STAGES).optional() });

export const POST = route(async (req, { user }) => {
  const b = Bulk.parse(await body(req));
  let n = 0;
  for (const id of b.ids) {
    if (b.action === "stage") { if (!b.stage) throw new Error("stage is required"); await setStage(id, b.stage, user!.email); n++; continue; }
    const kind = b.action === "research" ? "research" : b.action === "find_contacts" ? "contacts" : "outreach";
    await enqueueRun({ kind, leadId: id, input: kind === "outreach" ? { step: 1 } : kind === "contacts" ? {} : { thenOutreach: false }, idempotencyKey: `${kind}:${id}:${Date.now() >> 12}`, createdBy: user!.email });
    n++;
  }
  return { ok: true, count: n };
});
