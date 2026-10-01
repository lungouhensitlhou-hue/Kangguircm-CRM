import { query, queryOne, tx } from "./db";
import { audit } from "./settings";
import { isValidEmail, normalizeEmail } from "./compliance";
import { emailStats } from "./tracking";
import { STAGES, type Contact, type Lead, type Organization, type Stage } from "./types";

export interface LeadRow extends Lead {
  org: Organization;
}

export interface NewOrg {
  name: string;
  npi?: string | null;
  entity_type?: "organization" | "individual";
  specialty?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  website?: string | null;
  source?: string;
  /** Authorized official from the registry; stored as a decision-maker contact. */
  /** Other names the organization trades under (DBA), useful for finding its website. */
  aliases?: string[];
  official?: { name: string; title: string | null; phone: string | null; credential: string | null };
}

const clean = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

export function normalizeWebsite(w: string | null | undefined): string | null {
  const v = clean(w);
  if (!v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (!u.hostname.includes(".")) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Create the org + lead unless a duplicate (by NPI, or name+city+state) exists. */
export async function upsertLead(o: NewOrg): Promise<{ leadId: string; organizationId: string; created: boolean }> {
  const name = clean(o.name);
  if (!name) throw new Error("Organization name is required");
  const npi = clean(o.npi);
  const city = clean(o.city);
  const state = clean(o.state)?.toUpperCase() ?? null;
  const out = await tx(async (c) => {
    let org = npi ? (await c.query("SELECT id FROM organizations WHERE npi = $1", [npi])).rows[0] : undefined;
    if (!org) {
      org = (
        await c.query(
          "SELECT id FROM organizations WHERE lower(name) = lower($1) AND lower(coalesce(city,'')) = lower($2) AND lower(coalesce(state,'')) = lower($3)",
          [name, city ?? "", state ?? ""],
        )
      ).rows[0];
    }
    let created = false;
    if (!org) {
      org = (
        await c.query(
          `INSERT INTO organizations (npi, name, entity_type, specialty, address, city, state, zip, phone, website, source, aliases)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [npi, name, o.entity_type ?? "organization", clean(o.specialty), clean(o.address), city, state, clean(o.zip), clean(o.phone), normalizeWebsite(o.website), o.source ?? "manual", o.aliases ?? []],
        )
      ).rows[0];
      created = true;
    }
    let lead = (await c.query("SELECT id FROM leads WHERE organization_id = $1", [org.id])).rows[0];
    if (!lead) {
      lead = (await c.query("INSERT INTO leads (organization_id) VALUES ($1) RETURNING id", [org.id])).rows[0];
      created = true;
    }
    return { leadId: lead.id as string, organizationId: org.id as string, created };
  });
  if (o.official) await addOfficialContact(out.organizationId, o.official);
  return out;
}

/** Idempotent: registry officials have no email, so the upsert key is the name. */
export async function addOfficialContact(orgId: string, official: NonNullable<NewOrg["official"]>): Promise<void> {
  const exists = await queryOne("SELECT 1 FROM contacts WHERE organization_id = $1 AND lower(full_name) = lower($2)", [orgId, official.name]);
  if (exists) return;
  await query(
    "INSERT INTO contacts (organization_id, full_name, title, phone, is_decision_maker, source) VALUES ($1,$2,$3,$4,true,'nppes')",
    [orgId, official.name, official.title, official.phone],
  );
}

export interface LeadFilter {
  q?: string;
  stage?: string;
  state?: string;
  specialty?: string;
  minScore?: number;
  sort?: "score" | "recent" | "name";
  limit?: number;
  offset?: number;
}

export async function listLeads(f: LeadFilter = {}): Promise<{ rows: LeadRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (f.q) {
    params.push(`%${f.q}%`);
    const p = `$${params.length}`;
    where.push(`(o.name ILIKE ${p} OR o.city ILIKE ${p} OR o.specialty ILIKE ${p})`);
  }
  if (f.stage && (STAGES as readonly string[]).includes(f.stage)) add("l.stage = ?", f.stage);
  if (f.state) add("o.state = ?", f.state.toUpperCase());
  if (f.specialty) add("o.specialty ILIKE ?", `%${f.specialty}%`);
  if (f.minScore) add("l.score >= ?", f.minScore);
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order = f.sort === "name" ? "o.name ASC" : f.sort === "recent" ? "l.created_at DESC" : "l.score DESC, l.created_at DESC";
  const total = (await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM leads l JOIN organizations o ON o.id = l.organization_id ${w}`, params))!.n;
  const lim = Math.max(1, Math.min(Math.trunc(Number(f.limit ?? 50)) || 50, 500));
  const off = Math.max(0, Math.trunc(Number(f.offset ?? 0)) || 0);
  const rows = await query(
    `SELECT l.*, to_jsonb(o.*) AS org FROM leads l JOIN organizations o ON o.id = l.organization_id ${w}
     ORDER BY ${order} LIMIT ${lim} OFFSET ${off}`,
    params,
  );
  return { rows: rows as LeadRow[], total };
}

export async function getLead(id: string): Promise<LeadRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return queryOne<LeadRow>("SELECT l.*, to_jsonb(o.*) AS org FROM leads l JOIN organizations o ON o.id = l.organization_id WHERE l.id = $1", [id]);
}

export async function getContacts(orgId: string): Promise<Contact[]> {
  return query<Contact>("SELECT * FROM contacts WHERE organization_id = $1 ORDER BY is_decision_maker DESC, created_at", [orgId]);
}

export async function addContact(
  orgId: string,
  c: { full_name?: string | null; title?: string | null; email?: string | null; phone?: string | null; is_decision_maker?: boolean; source?: string; source_url?: string | null },
): Promise<Contact | null> {
  const email = c.email && isValidEmail(c.email) ? normalizeEmail(c.email) : null;
  if (!email && !clean(c.full_name)) return null;
  const row = await queryOne<Contact>(
    `INSERT INTO contacts (organization_id, full_name, title, email, phone, is_decision_maker, source, source_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (organization_id, lower(email)) WHERE email IS NOT NULL
     DO UPDATE SET full_name = COALESCE(contacts.full_name, EXCLUDED.full_name), title = COALESCE(contacts.title, EXCLUDED.title),
                   is_decision_maker = contacts.is_decision_maker OR EXCLUDED.is_decision_maker
     RETURNING *`,
    [orgId, clean(c.full_name), clean(c.title), email, clean(c.phone), c.is_decision_maker ?? false, c.source ?? "manual", clean(c.source_url)],
  );
  return row;
}

export async function setStage(leadId: string, stage: Stage, actor = "system"): Promise<void> {
  if (!(STAGES as readonly string[]).includes(stage)) throw new Error(`Invalid stage: ${stage}`);
  const row = await queryOne<{ stage: string }>("SELECT stage FROM leads WHERE id = $1", [leadId]);
  if (!row) throw new Error("Lead not found");
  if (row.stage === stage) return;
  await query("UPDATE leads SET stage = $2, updated_at = now() WHERE id = $1", [leadId, stage]);
  await audit(actor, "stage_change", "lead", leadId, { from: row.stage, to: stage });
  await syncDealAndTasks(leadId, stage);
}

/** Keep deals and tasks consistent with the pipeline: Meeting opens a deal, Won/Lost close it, dead leads drop their to-dos. */
async function syncDealAndTasks(leadId: string, stage: Stage): Promise<void> {
  if (stage === "meeting") {
    await query(
      `INSERT INTO deals (lead_id, name, source) SELECT l.id, o.name || ' - RCM services', 'auto' FROM leads l JOIN organizations o ON o.id = l.organization_id WHERE l.id = $1
       ON CONFLICT (lead_id) WHERE status = 'open' DO NOTHING`,
      [leadId],
    );
  } else if (stage === "won") {
    const closed = await queryOne("UPDATE deals SET status = 'won', closed_at = now() WHERE lead_id = $1 AND status = 'open' RETURNING id", [leadId]);
    if (!closed && !(await queryOne("SELECT 1 FROM deals WHERE lead_id = $1 AND status = 'won'", [leadId]))) {
      await query("INSERT INTO deals (lead_id, name, status, closed_at, source) SELECT l.id, o.name || ' - RCM services', 'won', now(), 'auto' FROM leads l JOIN organizations o ON o.id = l.organization_id WHERE l.id = $1", [leadId]);
    }
  } else if (stage === "lost" || stage === "disqualified") {
    await query("UPDATE deals SET status = 'lost', closed_at = now() WHERE lead_id = $1 AND status = 'open'", [leadId]);
    await query("UPDATE tasks SET status = 'dismissed', completed_at = now() WHERE lead_id = $1 AND status = 'open'", [leadId]);
  }
}

export async function updateLead(leadId: string, patch: { notes?: string; stage?: Stage; next_action_at?: string | null }, actor = "user"): Promise<void> {
  if (patch.stage) await setStage(leadId, patch.stage, actor);
  if (patch.notes !== undefined) await query("UPDATE leads SET notes = $2, updated_at = now() WHERE id = $1", [leadId, patch.notes]);
  if (patch.next_action_at !== undefined) await query("UPDATE leads SET next_action_at = $2, updated_at = now() WHERE id = $1", [leadId, patch.next_action_at]);
}

export async function pipelineStats() {
  const email = await emailStats();
  const stages = await query<{ stage: string; n: number }>("SELECT stage, count(*)::int AS n FROM leads GROUP BY stage");
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const r of stages) byStage[r.stage as Stage] = r.n;
  const total = Object.values(byStage).reduce((a, b) => a + b, 0);
  const msg = (await queryOne<{ sent: number; replies: number; drafts: number }>(
    `SELECT count(*) FILTER (WHERE direction='outbound' AND status='sent')::int AS sent,
            count(*) FILTER (WHERE direction='inbound')::int AS replies,
            count(*) FILTER (WHERE direction='outbound' AND status='draft')::int AS drafts FROM messages`,
  ))!;
  const runs = (await queryOne<{ running: number; queued: number; failed24: number; cost: number }>(
    `SELECT count(*) FILTER (WHERE status='running')::int AS running,
            count(*) FILTER (WHERE status='queued')::int AS queued,
            count(*) FILTER (WHERE status='failed' AND created_at > now() - interval '24 hours')::int AS failed24,
            COALESCE(sum(cost_usd) FILTER (WHERE created_at > now() - interval '30 days'),0)::float AS cost
     FROM agent_runs`,
  ))!;
  return {
    total,
    byStage,
    messages: msg,
    runs,
    email,
    replyRate: msg.sent ? Math.round((msg.replies / msg.sent) * 1000) / 10 : 0,
  };
}

/** Parse a CSV string (RFC-4180-ish: quotes, embedded commas/newlines) into header-keyed rows. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
}

/** Import leads (and optional contact) from parsed CSV rows. Column aliases are tolerated. */
export async function importRows(rows: Record<string, string>[]): Promise<{ created: number; existing: number; skipped: number; contacts: number }> {
  const pick = (r: Record<string, string>, ...keys: string[]) => keys.map((k) => r[k]).find((v) => v && v.trim()) ?? "";
  let created = 0, existing = 0, skipped = 0, contacts = 0;
  for (const r of rows) {
    const name = pick(r, "name", "organization", "practice", "practice_name", "facility", "company");
    if (!name) { skipped++; continue; }
    const res = await upsertLead({
      name,
      npi: pick(r, "npi"),
      specialty: pick(r, "specialty", "taxonomy"),
      city: pick(r, "city"),
      state: pick(r, "state"),
      zip: pick(r, "zip", "postal_code"),
      phone: pick(r, "phone"),
      address: pick(r, "address"),
      website: pick(r, "website", "url", "domain"),
      source: "csv",
    });
    res.created ? created++ : existing++;
    const email = pick(r, "email", "contact_email");
    const cname = pick(r, "contact_name", "contact", "full_name");
    if (email || cname) {
      const c = await addContact(res.organizationId, {
        full_name: cname, email, title: pick(r, "title", "contact_title"), source: "csv",
        is_decision_maker: /manager|director|owner|administrator|ceo|coo|cfo|president|partner|billing/i.test(pick(r, "title", "contact_title")),
      });
      if (c) contacts++;
    }
  }
  return { created, existing, skipped, contacts };
}
