import { query, queryOne } from "./db";

const POSITIVE = ["interested", "question", "referral"];

/** Wilson score interval for a proportion (95%): honest uncertainty for small samples. Returns [low, high] in percent. */
export function wilson(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96, p = successes / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [Math.max(0, Math.round(((c - m) / d) * 1000) / 10), Math.min(100, Math.round(((c + m) / d) * 1000) / 10)];
}

export interface FunnelStep { key: string; label: string; count: number; pctOfPrev: number | null; pctOfTotal: number }

/** Lead funnel from facts (not current stage): every lead is counted at the furthest point it actually reached. */
export async function funnel(): Promise<FunnelStep[]> {
  const r = (await queryOne<any>(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM research_profiles p WHERE p.lead_id = l.id))::int AS researched,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM contacts c WHERE c.organization_id = l.organization_id AND c.email IS NOT NULL AND c.email_status NOT IN ('invalid','bounced')))::int AS reachable,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id AND m.direction = 'outbound' AND m.status = 'sent'))::int AS emailed,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id AND m.direction = 'inbound' AND m.classification IS DISTINCT FROM 'out_of_office'))::int AS replied,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id AND m.direction = 'inbound' AND m.classification = ANY($1::text[])))::int AS positive,
       count(*) FILTER (WHERE l.stage IN ('meeting','won') OR EXISTS (SELECT 1 FROM deals d WHERE d.lead_id = l.id))::int AS meetings,
       count(*) FILTER (WHERE l.stage = 'won' OR EXISTS (SELECT 1 FROM deals d WHERE d.lead_id = l.id AND d.status = 'won'))::int AS won
     FROM leads l`,
    [POSITIVE],
  ))!;
  const steps: [string, string, number][] = [["leads", "Leads", r.total], ["researched", "Researched", r.researched], ["reachable", "Has a usable email", r.reachable], ["emailed", "Emailed", r.emailed], ["replied", "Replied", r.replied], ["positive", "Positive reply", r.positive], ["meetings", "Meeting / deal", r.meetings], ["won", "Won", r.won]];
  return steps.map(([key, label, count], i) => ({ key, label, count, pctOfPrev: i === 0 ? null : steps[i - 1][2] ? Math.round((count / steps[i - 1][2]) * 1000) / 10 : 0, pctOfTotal: r.total ? Math.round((count / r.total) * 1000) / 10 : 0 }));
}

export type GroupBy = "specialty" | "template" | "step" | "state";
export interface OutreachRow { group: string; sent: number; delivered: number; bounced: number; replies: number; positive: number; replyRate: number; ci: [number, number]; enough: boolean }

/**
 * Per-group outreach results. Each reply is attributed to the most recent email sent before it, so a lead that replies
 * after a 3-email sequence counts once, for the email that actually preceded the reply. `enough` is false below 30 sends:
 * differences between small groups are noise.
 */
export async function outreachStats(o: { groupBy: GroupBy; days?: number }): Promise<OutreachRow[]> {
  const g = { specialty: "COALESCE(org.specialty, '(unknown)')", template: "COALESCE(m.variant, 'AI / default')", step: "('Step ' || m.step)", state: "COALESCE(org.state, '(unknown)')" }[o.groupBy];
  if (!g) throw new Error("Invalid grouping");
  const rows = await query<any>(
    `WITH sent AS (
       SELECT m.id, m.lead_id, m.sent_at, m.delivered_at, m.bounced_at, ${g} AS grp
       FROM messages m JOIN leads l ON l.id = m.lead_id JOIN organizations org ON org.id = l.organization_id
       WHERE m.direction = 'outbound' AND m.status = 'sent' AND ($1::int IS NULL OR m.sent_at > now() - ($1 || ' days')::interval)
     ), attributed AS (
       SELECT DISTINCT ON (r.id) r.id AS reply_id, s.id AS sent_id, r.classification
       FROM messages r JOIN sent s ON s.lead_id = r.lead_id AND s.sent_at < r.created_at
       WHERE r.direction = 'inbound' AND r.classification IS DISTINCT FROM 'out_of_office'
       ORDER BY r.id, s.sent_at DESC
     )
     SELECT s.grp AS "group", count(DISTINCT s.id)::int AS sent, count(DISTINCT s.id) FILTER (WHERE s.delivered_at IS NOT NULL)::int AS delivered,
            count(DISTINCT s.id) FILTER (WHERE s.bounced_at IS NOT NULL)::int AS bounced,
            count(a.reply_id)::int AS replies, count(a.reply_id) FILTER (WHERE a.classification = ANY($2::text[]))::int AS positive
     FROM sent s LEFT JOIN attributed a ON a.sent_id = s.id
     GROUP BY s.grp ORDER BY sent DESC, s.grp`,
    [o.days ?? null, POSITIVE],
  );
  return rows.map((r) => ({ ...r, replyRate: r.sent ? Math.round((r.replies / r.sent) * 1000) / 10 : 0, ci: wilson(r.replies, r.sent), enough: r.sent >= 30 }));
}

export async function replyTiming(days?: number): Promise<{ medianHours: number | null; n: number }> {
  const r = await queryOne<{ med: number | null; n: number }>(
    `WITH x AS (
       SELECT r.id, EXTRACT(EPOCH FROM (r.created_at - s.sent_at)) / 3600 AS hrs
       FROM messages r JOIN LATERAL (SELECT sent_at FROM messages m WHERE m.lead_id = r.lead_id AND m.direction = 'outbound' AND m.status = 'sent' AND m.sent_at < r.created_at ORDER BY m.sent_at DESC LIMIT 1) s ON true
       WHERE r.direction = 'inbound' AND r.classification IS DISTINCT FROM 'out_of_office' AND ($1::int IS NULL OR r.created_at > now() - ($1 || ' days')::interval)
     ) SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY hrs)::float AS med, count(*)::int AS n FROM x`,
    [days ?? null],
  );
  return { medianHours: r?.med == null ? null : Math.round(r.med * 10) / 10, n: r?.n ?? 0 };
}

/** AI spend divided by outcomes, so you can see what a positive reply or a meeting costs. */
export async function costPerOutcome(days?: number) {
  const r = (await queryOne<any>(
    `SELECT COALESCE((SELECT sum(cost_usd) FROM agent_runs WHERE $1::int IS NULL OR created_at > now() - ($1 || ' days')::interval), 0)::float AS spend,
            (SELECT count(*) FROM messages WHERE direction = 'inbound' AND classification = ANY($2::text[]) AND ($1::int IS NULL OR created_at > now() - ($1 || ' days')::interval))::int AS positive,
            (SELECT count(*) FROM deals WHERE $1::int IS NULL OR created_at > now() - ($1 || ' days')::interval)::int AS deals,
            (SELECT count(*) FROM leads)::int AS leads`,
    [days ?? null, POSITIVE],
  ))!;
  const per = (n: number) => (n ? Math.round((r.spend / n) * 100) / 100 : null);
  return { spend: Math.round(r.spend * 100) / 100, perLead: per(r.leads), perPositiveReply: per(r.positive), perDeal: per(r.deals), positive: r.positive, deals: r.deals };
}

export async function weekly(weeks = 8) {
  return query<{ week: string; sent: number; replies: number; bounced: number }>(
    `SELECT to_char(w, 'YYYY-MM-DD') AS week,
       (SELECT count(*) FROM messages m WHERE m.direction = 'outbound' AND m.status = 'sent' AND m.sent_at >= w AND m.sent_at < w + interval '7 days')::int AS sent,
       (SELECT count(*) FROM messages m WHERE m.direction = 'inbound' AND m.classification IS DISTINCT FROM 'out_of_office' AND m.created_at >= w AND m.created_at < w + interval '7 days')::int AS replies,
       (SELECT count(*) FROM messages m WHERE m.bounced_at >= w AND m.bounced_at < w + interval '7 days')::int AS bounced
     FROM generate_series(date_trunc('week', now()) - ($1 - 1) * interval '7 days', date_trunc('week', now()), interval '7 days') w ORDER BY w`,
    [weeks],
  );
}

// ---- per-lead activity timeline -------------------------------------------------------------------------------

export interface TimelineItem { at: string; kind: "email" | "reply" | "stage" | "task" | "deal" | "run" | "delivery"; title: string; detail?: string | null }

/** Everything that happened on a lead, newest first: emails, replies, stage changes, tasks, deals, agent runs, delivery events. */
export async function leadTimeline(leadId: string, limit = 60): Promise<TimelineItem[]> {
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) return [];
  return query<TimelineItem>(
    `SELECT * FROM (
       SELECT COALESCE(m.sent_at, m.created_at) AS at, CASE WHEN m.direction = 'inbound' THEN 'reply' ELSE 'email' END AS kind,
              CASE WHEN m.direction = 'inbound' THEN 'Reply received' || COALESCE(' (' || replace(m.classification, '_', ' ') || ')', '')
                   ELSE 'Email step ' || m.step || ' ' || m.status END AS title,
              m.subject AS detail
       FROM messages m WHERE m.lead_id = $1
       UNION ALL SELECT a.created_at, 'stage', 'Stage: ' || (a.data->>'from') || ' → ' || (a.data->>'to'), 'by ' || a.actor
         FROM audit_log a WHERE a.entity = 'lead' AND a.entity_id = $1::text AND a.action = 'stage_change'
       UNION ALL SELECT t.created_at, 'task', 'Task added: ' || t.title, t.source FROM tasks t WHERE t.lead_id = $1
       UNION ALL SELECT t.completed_at, 'task', 'Task ' || t.status || ': ' || t.title, NULL FROM tasks t WHERE t.lead_id = $1 AND t.completed_at IS NOT NULL
       UNION ALL SELECT d.created_at, 'deal', 'Deal opened: ' || d.name, '$' || d.value_usd FROM deals d WHERE d.lead_id = $1
       UNION ALL SELECT d.closed_at, 'deal', 'Deal ' || d.status, '$' || d.value_usd FROM deals d WHERE d.lead_id = $1 AND d.closed_at IS NOT NULL
       UNION ALL SELECT r.created_at, 'run', 'Agent: ' || r.kind || ' ' || r.status, r.error FROM agent_runs r WHERE r.lead_id = $1 AND r.kind <> 'sweep'
       UNION ALL SELECT e.created_at, 'delivery', 'Email ' || e.type || CASE WHEN e.detail = 'suspected-bot' THEN ' (scanner, not counted)' ELSE '' END, e.provider
         FROM email_events e JOIN messages m ON m.id = e.message_id WHERE m.lead_id = $1 AND e.type <> 'deferred'
     ) x WHERE at IS NOT NULL ORDER BY at DESC LIMIT $2`,
    [leadId, limit],
  );
}
