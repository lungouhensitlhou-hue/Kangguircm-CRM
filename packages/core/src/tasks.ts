import { query, queryOne } from "./db";
import { audit } from "./settings";

export const TASK_KINDS = ["call", "email", "review", "research", "other"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export interface Task {
  id: string; lead_id: string | null; title: string; kind: TaskKind; due_at: string; status: "open" | "done" | "dismissed";
  notes: string; source: string; created_by: string; created_at: string; completed_at: string | null;
}
export interface TaskRow extends Task { org_name: string | null }

export interface NewTask { leadId?: string | null; title: string; kind?: TaskKind; dueAt?: Date; notes?: string; source?: string; createdBy?: string; dedupeKey?: string }

/** Create a task. With a dedupeKey this is idempotent (agents can call it on every run without piling up duplicates). */
export async function createTask(t: NewTask): Promise<Task | null> {
  const title = t.title.trim().slice(0, 300);
  if (!title) throw new Error("Task title is required");
  if (t.kind && !TASK_KINDS.includes(t.kind)) throw new Error(`Invalid task kind: ${t.kind}`);
  return queryOne<Task>(
    `INSERT INTO tasks (lead_id, title, kind, due_at, notes, source, created_by, dedupe_key)
     VALUES ($1,$2,$3,COALESCE($4, now()),$5,$6,$7,$8)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    [t.leadId ?? null, title, t.kind ?? "other", t.dueAt ?? null, (t.notes ?? "").slice(0, 2000), t.source ?? "manual", t.createdBy ?? "system", t.dedupeKey ?? null],
  );
}

export type TaskBucket = "overdue" | "today" | "upcoming" | "done" | "all";

/** End of "today" in the server's UTC day; tasks due before it that are not overdue count as today. */
export async function listTasks(o: { bucket?: TaskBucket; leadId?: string; limit?: number } = {}): Promise<TaskRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const b = o.bucket ?? "all";
  if (b === "done") where.push("t.status = 'done'");
  else if (b === "overdue") where.push("t.status = 'open' AND t.due_at < date_trunc('day', now())");
  else if (b === "today") where.push("t.status = 'open' AND t.due_at >= date_trunc('day', now()) AND t.due_at < date_trunc('day', now()) + interval '1 day'");
  else if (b === "upcoming") where.push("t.status = 'open' AND t.due_at >= date_trunc('day', now()) + interval '1 day'");
  else where.push("t.status = 'open'");
  if (o.leadId) { params.push(o.leadId); where.push(`t.lead_id = $${params.length}`); }
  params.push(Math.min(o.limit ?? 200, 500));
  return query<TaskRow>(
    `SELECT t.*, org.name AS org_name FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN organizations org ON org.id = l.organization_id
     WHERE ${where.join(" AND ")} ORDER BY ${b === "done" ? "t.completed_at DESC NULLS LAST" : "t.due_at"} LIMIT $${params.length}`,
    params,
  );
}

/** Open tasks that are due now or earlier (overdue + due today so far). Used for the nav badge. */
export async function dueCount(): Promise<number> {
  return (await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM tasks WHERE status = 'open' AND due_at <= now() + interval '0 seconds'"))!.n;
}

export async function taskCounts() {
  return (await queryOne<{ overdue: number; today: number; upcoming: number }>(
    `SELECT count(*) FILTER (WHERE due_at < date_trunc('day', now()))::int AS overdue,
            count(*) FILTER (WHERE due_at >= date_trunc('day', now()) AND due_at < date_trunc('day', now()) + interval '1 day')::int AS today,
            count(*) FILTER (WHERE due_at >= date_trunc('day', now()) + interval '1 day')::int AS upcoming
     FROM tasks WHERE status = 'open'`,
  ))!;
}

export async function updateTask(id: string, patch: { status?: "open" | "done" | "dismissed"; dueAt?: Date; title?: string; notes?: string }, actor = "user"): Promise<Task> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Task not found");
  const cur = await queryOne<Task>("SELECT * FROM tasks WHERE id = $1", [id]);
  if (!cur) throw new Error("Task not found");
  if (patch.title !== undefined && !patch.title.trim()) throw new Error("Task title is required");
  const status = patch.status ?? cur.status;
  const row = await queryOne<Task>(
    `UPDATE tasks SET status = $2, due_at = COALESCE($3, due_at), title = COALESCE($4, title), notes = COALESCE($5, notes),
       completed_at = CASE WHEN $2 = 'open' THEN NULL WHEN completed_at IS NULL THEN now() ELSE completed_at END
     WHERE id = $1 RETURNING *`,
    [id, status, patch.dueAt ?? null, patch.title?.trim().slice(0, 300) ?? null, patch.notes?.slice(0, 2000) ?? null],
  );
  if (patch.status && patch.status !== cur.status) await audit(actor, `task_${patch.status}`, "task", id);
  return row!;
}
