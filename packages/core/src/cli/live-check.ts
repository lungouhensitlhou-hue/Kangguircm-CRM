/**
 * Live connection test of everything configured in the environment (never sends an email; keys are never printed).
 * Usage: npm run live:check
 */
import { depsFromEnv } from "../agents/deps";
import { closePool, migrateWithRetry } from "../db";
import { runDiagnostics } from "../diagnostics";

await migrateWithRetry();
const results = await runDiagnostics(depsFromEnv(), { deep: true });
const icon = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP" } as const;
for (const r of results) console.log(`${icon[r.status]}  ${r.name}: ${r.detail.replace(/(sk-|SG\.|re_|key=)[A-Za-z0-9_\-]{6,}/g, "$1***")}${r.hint ? `\n        → ${r.hint}` : ""}`);
const failed = results.filter((r) => r.status === "fail").length;
console.log(failed ? `\n${failed} check(s) FAILED` : "\nNo failures");
await closePool();
process.exit(failed ? 1 : 0);
