import crypto from "node:crypto";
import { query, queryOne } from "./db";

export interface Template { id: string; name: string; subject: string; body: string; active: boolean; created_at: string; updated_at: string }

/** Merge fields available in subject/body. Use {{field}} or {{field|fallback text}}. */
export const MERGE_FIELDS: Record<string, string> = {
  first_name: "Contact's first name",
  full_name: "Contact's full name",
  title: "Contact's job title",
  practice: "Practice / facility name",
  city: "City",
  state: "State",
  specialty: "Primary specialty",
  ehr: "EHR system, if known",
  sender_name: "Your name",
  sender_first_name: "Your first name",
  company: "Your company",
};

const TOKEN = /\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi;

export function usedFields(text: string): string[] {
  return [...text.matchAll(TOKEN)].map((m) => m[1].toLowerCase());
}

/** Reject templates that reference unknown fields or have broken braces. Returns a list of problems (empty = fine). */
export function validateTemplate(t: { name?: string; subject: string; body: string }): string[] {
  const errs: string[] = [];
  if (t.name !== undefined && !t.name.trim()) errs.push("Name is required");
  if (!t.subject.trim()) errs.push("Subject is required");
  if (t.body.trim().length < 20) errs.push("Body is too short");
  if (t.subject.length > 150) errs.push("Subject is too long (150 characters max)");
  for (const f of new Set([...usedFields(t.subject), ...usedFields(t.body)])) if (!(f in MERGE_FIELDS)) errs.push(`Unknown merge field {{${f}}}`);
  const stripped = (t.subject + t.body).replace(TOKEN, "");
  if (/\{\{|\}\}/.test(stripped)) errs.push("Unbalanced {{ }} braces");
  if (/unsubscribe/i.test(t.body)) errs.push("Do not write your own unsubscribe line; the legally required footer is added automatically");
  return errs;
}

export type MergeValues = Partial<Record<keyof typeof MERGE_FIELDS, string | null | undefined>>;

/** Fill merge fields. A missing value with no {{field|fallback}} throws, so a half-empty email is never produced. */
export function renderTemplate(t: Pick<Template, "subject" | "body">, v: MergeValues): { subject: string; body: string } {
  const fill = (text: string) => text.replace(TOKEN, (_m, f: string, fallback?: string) => {
    const val = (v as Record<string, string | null | undefined>)[f.toLowerCase()]?.toString().trim();
    if (val) return val;
    if (fallback !== undefined) return fallback.trim();
    throw new Error(`No value for {{${f}}} (add a fallback like {{${f}|there}})`);
  });
  return { subject: fill(t.subject).replace(/\s+/g, " ").trim(), body: fill(t.body).trim() };
}

/** Deterministic A/B assignment: the same lead always gets the same variant. */
export function pickVariant(ids: string[], seed: string): string {
  const h = crypto.createHash("sha1").update(seed).digest();
  return ids[h.readUInt32BE(0) % ids.length];
}

export async function listTemplates(): Promise<Template[]> {
  return query<Template>("SELECT * FROM templates ORDER BY name");
}
export async function getTemplate(id: string): Promise<Template | null> {
  return /^[0-9a-f-]{36}$/i.test(id) ? queryOne<Template>("SELECT * FROM templates WHERE id = $1", [id]) : null;
}
export async function createTemplate(t: { name: string; subject: string; body: string }): Promise<Template> {
  const errs = validateTemplate(t);
  if (errs.length) throw new Error(`Invalid template: ${errs.join("; ")}`);
  try {
    return (await queryOne<Template>("INSERT INTO templates (name, subject, body) VALUES ($1,$2,$3) RETURNING *", [t.name.trim(), t.subject.trim(), t.body.trim()]))!;
  } catch (e) { if ((e as any).code === "23505") throw new Error("A template with that name already exists"); throw e; }
}
export async function updateTemplate(id: string, t: Partial<{ name: string; subject: string; body: string; active: boolean }>): Promise<Template> {
  const cur = await getTemplate(id);
  if (!cur) throw new Error("Template not found");
  const next = { name: t.name ?? cur.name, subject: t.subject ?? cur.subject, body: t.body ?? cur.body };
  const errs = validateTemplate(next);
  if (errs.length) throw new Error(`Invalid template: ${errs.join("; ")}`);
  try {
    return (await queryOne<Template>("UPDATE templates SET name = $2, subject = $3, body = $4, active = $5, updated_at = now() WHERE id = $1 RETURNING *", [id, next.name.trim(), next.subject.trim(), next.body.trim(), t.active ?? cur.active]))!;
  } catch (e) { if ((e as any).code === "23505") throw new Error("A template with that name already exists"); throw e; }
}
export async function deleteTemplate(id: string): Promise<void> {
  const used = await queryOne<{ name: string }>("SELECT name FROM sequences WHERE steps::text LIKE $1 LIMIT 1", [`%${id}%`]);
  if (used) throw new Error(`Cannot delete: used by sequence "${used.name}". Remove it from the sequence first`);
  await query("DELETE FROM templates WHERE id = $1", [id]);
}
