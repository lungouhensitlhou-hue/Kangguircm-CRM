import { closePool, depsFromEnv, migrate, runWorker } from "@rcm/core";

const deps = depsFromEnv();
const ac = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig} received, finishing in-flight runs...`);
    ac.abort();
  });
}

await migrate();
await runWorker(deps, {
  signal: ac.signal,
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 3),
  pollMs: Number(process.env.WORKER_POLL_MS ?? 1000),
});
await closePool();
