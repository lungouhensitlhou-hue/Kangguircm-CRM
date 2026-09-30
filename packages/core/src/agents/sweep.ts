import { query } from "../db";
import { getSettings } from "../settings";
import { enqueueRun, reclaimStaleRuns } from "../queue";
import type { Handler } from "./runtime";

/** Periodic housekeeping: reclaim dead runs, queue approved sends, draft due follow-ups. */
export const sweepHandler: Handler = async (ctx) => {
  const s = await getSettings();
  const reclaimed = await reclaimStaleRuns();

  const approved = await query<{ id: string; lead_id: string }>("SELECT id, lead_id FROM messages WHERE direction='outbound' AND status='approved'");
  for (const m of approved) await enqueueRun({ kind: "send", leadId: m.lead_id, input: { messageId: m.id }, idempotencyKey: `send:${m.id}`, createdBy: "system" });

  // Follow-ups: last sent step is due when now >= sent_at + followupDays[step-1], and nobody has replied.
  let followups = 0;
  if (s.followupDays.length) {
    const due = await query<{ lead_id: string; step: number; sent_at: string }>(
      `SELECT DISTINCT ON (m.lead_id) m.lead_id, m.step, m.sent_at
       FROM messages m JOIN leads l ON l.id = m.lead_id
       WHERE m.direction = 'outbound' AND m.status = 'sent' AND l.stage = 'contacted'
         AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.lead_id = m.lead_id AND r.direction = 'inbound')
       ORDER BY m.lead_id, m.step DESC`,
    );
    for (const d of due) {
      const gapDays = s.followupDays[d.step - 1];
      if (!gapDays) continue;
      if (ctx.now.getTime() < new Date(d.sent_at).getTime() + gapDays * 86400_000) continue;
      const r = await enqueueRun({ kind: "outreach", leadId: d.lead_id, input: { step: d.step + 1 }, idempotencyKey: `outreach:${d.lead_id}:${d.step + 1}`, createdBy: "system" });
      if (r.status === "queued" && r.attempts === 0) followups++;
    }
  }
  await ctx.log(`Sweep: reclaimed ${reclaimed}, approved-sends ${approved.length}, follow-ups queued ${followups}`);
  return { reclaimed, approvedQueued: approved.length, followups };
};
