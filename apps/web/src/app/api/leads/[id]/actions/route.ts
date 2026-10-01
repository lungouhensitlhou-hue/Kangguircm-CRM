import { z } from "zod";
import { enqueueRun, getLead } from "@rcm/core";
import { HttpError, body, route } from "@/lib/api";

export const dynamic = "force-dynamic";
const Action = z.object({ action: z.enum(["research", "draft_outreach", "research_and_draft", "find_contacts"]) });

export const POST = route<{ id: string }>(async (req, { params, user }) => {
  const lead = await getLead(params.id);
  if (!lead) throw new HttpError(404, "Lead not found");
  const { action } = Action.parse(await body(req));
  const stamp = Date.now();
  const run =
    action === "find_contacts"
      ? await enqueueRun({ kind: "contacts", leadId: lead.id, input: {}, idempotencyKey: `contacts:${lead.id}:manual:${stamp}`, createdBy: user!.email })
      : action === "draft_outreach"
      ? await enqueueRun({ kind: "outreach", leadId: lead.id, input: { step: 1 }, idempotencyKey: `outreach:${lead.id}:1:manual:${stamp}`, createdBy: user!.email })
      : await enqueueRun({ kind: "research", leadId: lead.id, input: { thenOutreach: action === "research_and_draft" }, idempotencyKey: `research:${lead.id}:manual:${stamp}`, createdBy: user!.email });
  return { runId: run.id };
});
