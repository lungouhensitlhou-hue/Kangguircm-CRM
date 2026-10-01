import { z } from "zod";
import { STAGES, enrollLead, getContacts, getLead, query, queryOne, setSequencePaused, updateLead } from "@rcm/core";
import { HttpError, body, route } from "@/lib/api";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const lead = await getLead(params.id);
  if (!lead) throw new HttpError(404, "Lead not found");
  const [contacts, profile, messages, runs] = await Promise.all([
    getContacts(lead.organization_id),
    queryOne("SELECT * FROM research_profiles WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1", [lead.id]),
    query("SELECT * FROM messages WHERE lead_id = $1 ORDER BY created_at", [lead.id]),
    query("SELECT id, kind, status, created_at, error FROM agent_runs WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 20", [lead.id]),
  ]);
  return { lead, contacts, profile, messages, runs };
});

const Patch = z.object({ stage: z.enum(STAGES).optional(), notes: z.string().max(20000).optional(), next_action_at: z.string().datetime().nullable().optional(), tags: z.array(z.string().max(40)).max(40).optional(), sequenceId: z.string().uuid().nullable().optional(), sequencePaused: z.boolean().optional() });
export const PATCH = route<{ id: string }>(async (req, { params, user }) => {
  const lead = await getLead(params.id);
  if (!lead) throw new HttpError(404, "Lead not found");
  const { sequenceId, sequencePaused, ...rest } = Patch.parse(await body(req));
  await updateLead(lead.id, rest, user!.email);
  if (sequenceId !== undefined) await enrollLead(lead.id, sequenceId);
  if (sequencePaused !== undefined) await setSequencePaused(lead.id, sequencePaused);
  return { ok: true };
});
