import { query } from "../db";
import { sequenceSteps, type SequenceStep } from "../sequences";
import { enqueueRun, reclaimStaleRuns } from "../queue";
import type { Handler } from "./runtime";

/** Periodic housekeeping: reclaim dead runs, queue approved sends, draft due follow-ups. */
export const sweepHandler: Handler = async (ctx) => {
  const reclaimed = await reclaimStaleRuns();

  const approved = await query<{ id: string; lead_id: string }>("SELECT id, lead_id FROM messages WHERE direction='outbound' AND status='approved'");
  for (const m of approved) await enqueueRun({ kind: "send", leadId: m.lead_id, input: { messageId: m.id }, idempotencyKey: `send:${m.id}`, createdBy: "system" });

  // Follow-ups: the last sent step is due when now >= sent_at + (delay of the next step in the lead's sequence), nobody has replied, and the sequence is not paused.
  let followups = 0;
  const due = await query<{ lead_id: string; step: number; sent_at: string; sequence_id: string | null }>(
    `SELECT DISTINCT ON (m.lead_id) m.lead_id, m.step, m.sent_at, l.sequence_id
     FROM messages m JOIN leads l ON l.id = m.lead_id
     WHERE m.direction = 'outbound' AND m.status = 'sent' AND l.stage = 'contacted' AND NOT l.sequence_paused
       AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.lead_id = m.lead_id AND r.direction = 'inbound')
     ORDER BY m.lead_id, m.step DESC`,
  );
  const cache = new Map<string, SequenceStep[]>();
  for (const d of due) {
    const k = d.sequence_id ?? "default";
    if (!cache.has(k)) cache.set(k, await sequenceSteps({ sequence_id: d.sequence_id }));
    const next = cache.get(k)![d.step]; // steps[step] is the step after the one just sent
    if (!next || !next.delayDays) continue;
    if (ctx.now.getTime() < new Date(d.sent_at).getTime() + next.delayDays * 86400_000) continue;
    const r = await enqueueRun({ kind: "outreach", leadId: d.lead_id, input: { step: d.step + 1 }, idempotencyKey: `outreach:${d.lead_id}:${d.step + 1}`, createdBy: "system" });
    if (r.status === "queued" && r.attempts === 0) followups++;
  }
  await ctx.log(`Sweep: reclaimed ${reclaimed}, approved-sends ${approved.length}, follow-ups queued ${followups}`);
  return { reclaimed, approvedQueued: approved.length, followups };
};
