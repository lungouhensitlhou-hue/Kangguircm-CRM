import { query, queryOne, tx } from "./db";
import type { AgentRun, RunKind } from "./types";

export interface EnqueueOptions {
  kind: RunKind;
  input?: Record<string, unknown>;
  leadId?: string | null;
  parentId?: string | null;
  idempotencyKey?: string;
  runAt?: Date;
  maxAttempts?: number;
  createdBy?: string;
}

/** Enqueue a run. With an idempotencyKey, a duplicate returns the existing run instead of creating another. */
export async function enqueueRun(opts: EnqueueOptions): Promise<AgentRun> {
  const row = await queryOne<AgentRun>(
    `INSERT INTO agent_runs (kind, input, lead_id, parent_id, idempotency_key, run_at, max_attempts, created_by)
     VALUES ($1, $2::jsonb, $3, $4, $5, COALESCE($6, now()), $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      opts.kind,
      JSON.stringify(opts.input ?? {}),
      opts.leadId ?? null,
      opts.parentId ?? null,
      opts.idempotencyKey ?? null,
      opts.runAt ?? null,
      opts.maxAttempts ?? 3,
      opts.createdBy ?? "system",
    ],
  );
  if (row) return row;
  const existing = await queryOne<AgentRun>("SELECT * FROM agent_runs WHERE idempotency_key = $1", [opts.idempotencyKey]);
  if (!existing) throw new Error("enqueueRun: conflict but no existing run");
  return existing;
}

/** Atomically claim the next due run. Safe with many concurrent workers. */
export async function claimRun(workerId: string): Promise<AgentRun | null> {
  return tx(async (c) => {
    const { rows } = await c.query(
      `SELECT id FROM agent_runs
       WHERE status = 'queued' AND run_at <= now()
       ORDER BY run_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    if (!rows[0]) return null;
    const upd = await c.query(
      `UPDATE agent_runs
       SET status = 'running', locked_at = now(), locked_by = $2, attempts = attempts + 1,
           started_at = COALESCE(started_at, now())
       WHERE id = $1 RETURNING *`,
      [rows[0].id, workerId],
    );
    return upd.rows[0] as AgentRun;
  });
}

export async function completeRun(
  id: string,
  output: Record<string, unknown>,
  usage?: { tokensIn?: number; tokensOut?: number; costUsd?: number },
): Promise<void> {
  await query(
    `UPDATE agent_runs SET status = 'succeeded', output = $2::jsonb, finished_at = now(), locked_at = NULL, locked_by = NULL, error = NULL,
       tokens_in = tokens_in + $3, tokens_out = tokens_out + $4, cost_usd = cost_usd + $5
     WHERE id = $1 AND status = 'running'`,
    [id, JSON.stringify(output), usage?.tokensIn ?? 0, usage?.tokensOut ?? 0, usage?.costUsd ?? 0],
  );
}

/** Retry with exponential backoff until max_attempts, then mark failed. Returns the resulting status. */
export async function failRun(id: string, error: string, retryable = true): Promise<"queued" | "failed"> {
  const row = await queryOne<{ attempts: number; max_attempts: number }>("SELECT attempts, max_attempts FROM agent_runs WHERE id = $1", [id]);
  if (!row) return "failed";
  if (retryable && row.attempts < row.max_attempts) {
    const delaySec = Math.min(300, 5 * 2 ** (row.attempts - 1));
    await query(
      `UPDATE agent_runs SET status = 'queued', run_at = now() + ($2 || ' seconds')::interval, error = $3, locked_at = NULL, locked_by = NULL
       WHERE id = $1 AND status = 'running'`,
      [id, String(delaySec), error],
    );
    return "queued";
  }
  await query(
    `UPDATE agent_runs SET status = 'failed', error = $2, finished_at = now(), locked_at = NULL, locked_by = NULL WHERE id = $1 AND status = 'running'`,
    [id, error],
  );
  return "failed";
}

export async function cancelRun(id: string): Promise<boolean> {
  const row = await queryOne(
    `UPDATE agent_runs SET status = 'cancelled', finished_at = now(), locked_at = NULL, locked_by = NULL
     WHERE id = $1 AND status IN ('queued','running') RETURNING id`,
    [id],
  );
  return !!row;
}

export async function isCancelled(id: string): Promise<boolean> {
  const row = await queryOne<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [id]);
  return row?.status === "cancelled";
}

/** Requeue runs whose worker died mid-flight (lock older than `staleAfterSec`). */
export async function reclaimStaleRuns(staleAfterSec = 600): Promise<number> {
  const rows = await query(
    `UPDATE agent_runs
     SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         error = 'worker lost (stale lock)', locked_at = NULL, locked_by = NULL,
         finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
     WHERE status = 'running' AND locked_at < now() - ($1 || ' seconds')::interval
     RETURNING id`,
    [String(staleAfterSec)],
  );
  return rows.length;
}

export async function emitEvent(runId: string, type: string, message: string, data?: unknown): Promise<void> {
  await query("INSERT INTO agent_events (run_id, type, message, data) VALUES ($1,$2,$3,$4)", [
    runId,
    type,
    message,
    data === undefined ? null : JSON.stringify(data),
  ]);
}

export async function listEvents(runId: string, afterId = 0, limit = 500) {
  return query<{ id: number; type: string; message: string; data: unknown; created_at: string }>(
    "SELECT id, type, message, data, created_at FROM agent_events WHERE run_id = $1 AND id > $2 ORDER BY id LIMIT $3",
    [runId, afterId, limit],
  );
}

export async function getRun(id: string): Promise<AgentRun | null> {
  return queryOne<AgentRun>("SELECT * FROM agent_runs WHERE id = $1", [id]);
}

export async function listRuns(opts: { limit?: number; status?: string; kind?: string } = {}): Promise<AgentRun[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
  if (opts.kind) { params.push(opts.kind); where.push(`kind = $${params.length}`); }
  params.push(opts.limit ?? 50);
  return query<AgentRun>(
    `SELECT * FROM agent_runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
}
