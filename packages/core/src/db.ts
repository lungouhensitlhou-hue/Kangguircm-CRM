import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Queryable = Pick<pg.Pool, "query">;

// int8 (20) and numeric (1700) arrive as strings by default; counts and costs here are small.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

const g = globalThis as unknown as { __rcmPool?: pg.Pool };

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://rcm:rcm@localhost:5432/rcm";
}

export function getPool(): pg.Pool {
  if (!g.__rcmPool) {
    g.__rcmPool = new pg.Pool({ connectionString: databaseUrl(), max: 10 });
  }
  return g.__rcmPool;
}

export async function closePool(): Promise<void> {
  if (g.__rcmPool) {
    const p = g.__rcmPool;
    g.__rcmPool = undefined;
    await p.end();
  }
}

export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await getPool().query(text, params as any[]);
  return res.rows as T[];
}

export async function queryOne<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function migrationsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
}

/** Applies pending SQL migrations in filename order; idempotent. Returns applied names. */
export async function migrate(): Promise<string[]> {
  const client = await getPool().connect();
  const applied: string[] = [];
  try {
    // Advisory lock so concurrent processes (web + worker boot) don't race.
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = fs.readdirSync(migrationsDir()).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir(), f), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
  return applied;
}

/** Startup-friendly migrate: waits for the database to accept connections (containers often start together). */
export async function migrateWithRetry(attempts = 30, delayMs = 2000, log: (m: string) => void = console.error): Promise<string[]> {
  for (let i = 1; ; i++) {
    try { return await migrate(); }
    catch (e) {
      const msg = (e as Error).message;
      const transient = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|the database system is (starting up|shutting down)|Connection terminated/i.test(msg);
      if (!transient || i >= attempts) throw new Error(`Database not usable after ${i} attempt(s): ${msg}. Check DATABASE_URL and that Postgres is running.`);
      log(`[db] waiting for database (${i}/${attempts}): ${msg}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
