import { query, queryOne } from "./db";
import { audit } from "./settings";
import { setStage } from "./leads";

export interface Deal {
  id: string; lead_id: string; name: string; value_usd: number; status: "open" | "won" | "lost";
  expected_close: string | null; notes: string; source: string; created_at: string; closed_at: string | null;
}
export interface DealRow extends Deal { org_name: string }

export async function listDeals(o: { status?: "open" | "won" | "lost"; leadId?: string } = {}): Promise<DealRow[]> {
  const where: string[] = []; const params: unknown[] = [];
  if (o.status) { params.push(o.status); where.push(`d.status = $${params.length}`); }
  if (o.leadId) { params.push(o.leadId); where.push(`d.lead_id = $${params.length}`); }
  return query<DealRow>(
    `SELECT d.*, org.name AS org_name FROM deals d JOIN leads l ON l.id = d.lead_id JOIN organizations org ON org.id = l.organization_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY (d.status = 'open') DESC, d.expected_close NULLS LAST, d.created_at DESC LIMIT 300`,
    params,
  );
}

export async function createDeal(o: { leadId: string; name?: string; valueUsd?: number; expectedClose?: string | null; notes?: string; source?: string }): Promise<Deal> {
  if (o.valueUsd !== undefined && (!Number.isFinite(o.valueUsd) || o.valueUsd < 0)) throw new Error("Deal value must be a non-negative number");
  const lead = await queryOne<{ name: string }>("SELECT org.name FROM leads l JOIN organizations org ON org.id = l.organization_id WHERE l.id = $1", [o.leadId]);
  if (!lead) throw new Error("Lead not found");
  const existing = await queryOne<Deal>("SELECT * FROM deals WHERE lead_id = $1 AND status = 'open'", [o.leadId]);
  if (existing) throw new Error("This lead already has an open deal");
  return (await queryOne<Deal>(
    "INSERT INTO deals (lead_id, name, value_usd, expected_close, notes, source) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [o.leadId, (o.name?.trim() || `${lead.name} - RCM services`).slice(0, 200), o.valueUsd ?? 0, o.expectedClose ?? null, (o.notes ?? "").slice(0, 2000), o.source ?? "manual"],
  ))!;
}

/** Update a deal. Closing it as won/lost also moves the lead's pipeline stage. */
export async function updateDeal(id: string, patch: { name?: string; valueUsd?: number; expectedClose?: string | null; notes?: string; status?: "open" | "won" | "lost" }, actor = "user"): Promise<Deal> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Deal not found");
  const cur = await queryOne<Deal>("SELECT * FROM deals WHERE id = $1", [id]);
  if (!cur) throw new Error("Deal not found");
  if (patch.valueUsd !== undefined && (!Number.isFinite(patch.valueUsd) || patch.valueUsd < 0)) throw new Error("Deal value must be a non-negative number");
  if (patch.expectedClose && isNaN(Date.parse(patch.expectedClose))) throw new Error("Invalid expected close date");
  if (patch.status === "open" && cur.status !== "open" && (await queryOne("SELECT 1 FROM deals WHERE lead_id = $1 AND status = 'open' AND id <> $2", [cur.lead_id, id]))) throw new Error("This lead already has another open deal");
  const status = patch.status ?? cur.status;
  const row = (await queryOne<Deal>(
    `UPDATE deals SET name = COALESCE($2, name), value_usd = COALESCE($3, value_usd), expected_close = CASE WHEN $4::boolean THEN $5::date ELSE expected_close END,
       notes = COALESCE($6, notes), status = $7, closed_at = CASE WHEN $7 = 'open' THEN NULL WHEN closed_at IS NULL THEN now() ELSE closed_at END
     WHERE id = $1 RETURNING *`,
    [id, patch.name?.trim().slice(0, 200) || null, patch.valueUsd ?? null, patch.expectedClose !== undefined, patch.expectedClose ?? null, patch.notes?.slice(0, 2000) ?? null, status],
  ))!;
  if (patch.status && patch.status !== cur.status) {
    await audit(actor, `deal_${patch.status}`, "deal", id, { value: row.value_usd });
    if (patch.status === "won") await setStage(cur.lead_id, "won", actor);
    if (patch.status === "lost") await setStage(cur.lead_id, "lost", actor);
    if (patch.status === "open") await setStage(cur.lead_id, "meeting", actor);
  }
  return row;
}

export async function dealStats() {
  const r = (await queryOne<any>(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open_n, COALESCE(sum(value_usd) FILTER (WHERE status = 'open'), 0)::float AS open_value,
            count(*) FILTER (WHERE status = 'won')::int AS won_n, COALESCE(sum(value_usd) FILTER (WHERE status = 'won'), 0)::float AS won_value,
            count(*) FILTER (WHERE status = 'lost')::int AS lost_n,
            COALESCE(avg(EXTRACT(EPOCH FROM (closed_at - created_at)) / 86400) FILTER (WHERE status = 'won'), 0)::float AS avg_days_to_win
     FROM deals`,
  ))!;
  const closed = r.won_n + r.lost_n;
  return { open: { count: r.open_n, value: r.open_value }, won: { count: r.won_n, value: r.won_value }, lost: { count: r.lost_n }, winRate: closed ? Math.round((r.won_n / closed) * 1000) / 10 : null, avgDaysToWin: Math.round(r.avg_days_to_win * 10) / 10 };
}
