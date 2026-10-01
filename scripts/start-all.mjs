// Single-container start for free hosts that offer no background worker:
// migrate, run the agent worker alongside the web server, restart the worker if it dies.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const port = process.env.PORT || "3000";
const inline = process.env.RUN_WORKER_INLINE !== "off";
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next", { paths: [process.cwd() + "/apps/web"] });
const sh = process.platform === "win32" ? "npm.cmd" : "npm";

const mig = spawnSync(sh, ["run", "db:migrate"], { stdio: "inherit" });
if (mig.status !== 0) { console.error("[start] migrations failed"); process.exit(mig.status ?? 1); }

const web = spawn(process.execPath, [nextBin, "start", "-p", port], { cwd: "apps/web", stdio: "inherit" });
let stopping = false;
let worker = null;

function startWorker() {
  worker = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: "apps/worker", stdio: "inherit" });
  worker.on("exit", (code) => {
    if (stopping) return;
    console.error(`[start] worker exited (${code}); restarting in 5s`);
    setTimeout(startWorker, 5000);
  });
}
if (inline) startWorker();

const stop = (sig) => { stopping = true; worker?.kill(sig); web.kill(sig); };
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => stop(s));
web.on("exit", (code) => { stopping = true; worker?.kill("SIGTERM"); process.exit(code ?? 0); });
