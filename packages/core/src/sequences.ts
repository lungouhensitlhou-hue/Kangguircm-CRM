import { query, queryOne } from "./db";
import { getSettings } from "./settings";

export interface SequenceStep { delayDays: number; templateIds?: string[] }
export interface Sequence { id: string; name: string; steps: SequenceStep[]; is_default: boolean; created_at: string }

const MAX_STEPS = 8;

export function validateSteps(steps: unknown): string[] {
  const errs: string[] = [];
  if (!Array.isArray(steps) || steps.length < 1) return ["A sequence needs at least one step"];
  if (steps.length > MAX_STEPS) errs.push(`At most ${MAX_STEPS} steps`);
  steps.forEach((s: any, i) => {
    if (!Number.isInteger(s?.delayDays) || s.delayDays < 0 || s.delayDays > 60) errs.push(`Step ${i + 1}: delay must be a whole number of days from 0 to 60`);
    if (i > 0 && s?.delayDays === 0) errs.push(`Step ${i + 1}: follow-ups need a delay of at least 1 day`);
    if (s?.templateIds !== undefined && (!Array.isArray(s.templateIds) || s.templateIds.some((t: unknown) => typeof t !== "string" || !/^[0-9a-f-]{36}$/i.test(t)))) errs.push(`Step ${i + 1}: invalid template list`);
    if ((s?.templateIds?.length ?? 0) > 4) errs.push(`Step ${i + 1}: at most 4 variants`);
  });
  return errs;
}

async function checkTemplatesExist(steps: SequenceStep[]) {
  const ids = [...new Set(steps.flatMap((s) => s.templateIds ?? []))];
  if (!ids.length) return;
  const found = await query<{ id: string }>("SELECT id FROM templates WHERE id = ANY($1::uuid[])", [ids]);
  const missing = ids.filter((i) => !found.some((f) => f.id === i));
  if (missing.length) throw new Error(`Unknown template in steps: ${missing[0]}`);
}

export async function listSequences(): Promise<Sequence[]> {
  return query<Sequence>("SELECT * FROM sequences ORDER BY is_default DESC, name");
}
export async function createSequence(o: { name: string; steps: SequenceStep[]; isDefault?: boolean }): Promise<Sequence> {
  if (!o.name.trim()) throw new Error("Name is required");
  const errs = validateSteps(o.steps);
  if (errs.length) throw new Error(`Invalid sequence: ${errs.join("; ")}`);
  await checkTemplatesExist(o.steps);
  try {
    if (o.isDefault) await query("UPDATE sequences SET is_default = false WHERE is_default");
    return (await queryOne<Sequence>("INSERT INTO sequences (name, steps, is_default) VALUES ($1,$2::jsonb,$3) RETURNING *", [o.name.trim(), JSON.stringify(o.steps), !!o.isDefault]))!;
  } catch (e) { if ((e as any).code === "23505") throw new Error("A sequence with that name already exists"); throw e; }
}
export async function updateSequence(id: string, o: Partial<{ name: string; steps: SequenceStep[]; isDefault: boolean }>): Promise<Sequence> {
  const cur = await queryOne<Sequence>("SELECT * FROM sequences WHERE id = $1", [/^[0-9a-f-]{36}$/i.test(id) ? id : "00000000-0000-0000-0000-000000000000"]);
  if (!cur) throw new Error("Sequence not found");
  const steps = o.steps ?? cur.steps;
  const errs = validateSteps(steps);
  if (errs.length) throw new Error(`Invalid sequence: ${errs.join("; ")}`);
  await checkTemplatesExist(steps);
  if (o.isDefault) await query("UPDATE sequences SET is_default = false WHERE is_default AND id <> $1", [id]);
  try {
    return (await queryOne<Sequence>("UPDATE sequences SET name = $2, steps = $3::jsonb, is_default = $4 WHERE id = $1 RETURNING *", [id, (o.name ?? cur.name).trim(), JSON.stringify(steps), o.isDefault ?? cur.is_default]))!;
  } catch (e) { if ((e as any).code === "23505") throw new Error("A sequence with that name already exists"); throw e; }
}
export async function deleteSequence(id: string): Promise<void> {
  await query("DELETE FROM sequences WHERE id = $1", [id]); // leads fall back to the default (ON DELETE SET NULL)
}

/**
 * The steps that apply to a lead: its own sequence, else the default sequence, else one synthesized from the
 * legacy "follow-up days" setting. steps[0] is the first email; steps[n].delayDays is the wait before step n+1.
 */
export async function sequenceSteps(lead: { sequence_id?: string | null }): Promise<SequenceStep[]> {
  if (lead.sequence_id) {
    const s = await queryOne<Sequence>("SELECT * FROM sequences WHERE id = $1", [lead.sequence_id]);
    if (s) return s.steps;
  }
  const d = await queryOne<Sequence>("SELECT * FROM sequences WHERE is_default");
  if (d) return d.steps;
  const s = await getSettings();
  return [{ delayDays: 0 }, ...s.followupDays.map((delayDays) => ({ delayDays }))];
}

export async function enrollLead(leadId: string, sequenceId: string | null): Promise<void> {
  if (sequenceId && !(await queryOne("SELECT 1 FROM sequences WHERE id = $1", [sequenceId]))) throw new Error("Sequence not found");
  await query("UPDATE leads SET sequence_id = $2, updated_at = now() WHERE id = $1", [leadId, sequenceId]);
}
export async function setSequencePaused(leadId: string, paused: boolean): Promise<void> {
  await query("UPDATE leads SET sequence_paused = $2, updated_at = now() WHERE id = $1", [leadId, paused]);
}
