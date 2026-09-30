import { closePool, depsFromEnv, hasBlockingIssues, migrateWithRetry, runWorker, validateConfig } from "@rcm/core";

process.on("unhandledRejection", (e) => console.error("[worker] unhandled rejection:", e));
process.on("uncaughtException", (e) => console.error("[worker] uncaught exception:", e));

const deps = depsFromEnv();
const ac = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig} received, finishing in-flight runs...`);
    ac.abort();
  });
}

const issues = validateConfig();
for (const i of issues.filter((x) => x.level !== "info")) console.error(`[config] ${i.level.toUpperCase()} ${i.key}: ${i.message} → ${i.fix}`);
if (hasBlockingIssues(issues) && process.env.NODE_ENV === "production") console.error("[config] Blocking problems above: the worker will start, but affected features will fail until fixed.");
await migrateWithRetry();
await runWorker(deps, {
  signal: ac.signal,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 3),
  pollMs: Number(process.env.WORKER_POLL_MS ?? 1000),
});
await closePool();
