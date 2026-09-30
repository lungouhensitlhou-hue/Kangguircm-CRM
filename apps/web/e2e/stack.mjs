// Boots the full stack for e2e: fake NPPES registry + fake practice site, fresh DB, worker, and the built Next app.
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { respond } from "../../../packages/core/test/fake-openai.mjs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DB = process.env.E2E_DATABASE_URL ?? "postgres://rcm:rcm@localhost:5432/rcm_e2e";
const FIX = 3191, WEB = 3190, READY = 3199;

// ---- fixtures: practice website + NPPES registry --------------------------------------------------
const site = (name) => ({
  "/": `<html><head><title>${name}</title></head><body><h1>${name}</h1><a href="/team">Our Team</a><a href="/contact">Contact</a><p>We use athenahealth. Three convenient locations. Now hiring: medical biller. We accept Medicare, Medicaid and most insurance.</p></body></html>`,
  "/team": `<html><body><div><strong>Jane Smith</strong><br>Practice Manager</div><p>Email <a href="mailto:jane.smith@e2e-ortho.test">jane.smith@e2e-ortho.test</a></p></body></html>`,
  "/contact": `<html><body>info@e2e-ortho.test</body></html>`,
});
const fixtures = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${FIX}`);
  if (u.pathname === "/nppes/") {
    const state = u.searchParams.get("state");
    const results = state === "TX" ? [
      { number: "1900000001", enumeration_type: "NPI-2", basic: { organization_name: "E2E ORTHOPEDIC ASSOCIATES" }, addresses: [{ address_purpose: "LOCATION", address_1: "1 Test Way", city: "AUSTIN", state: "TX", postal_code: "78701" }], taxonomies: [{ desc: "Orthopaedic Surgery", primary: true }] },
      { number: "1900000002", enumeration_type: "NPI-2", basic: { organization_name: "E2E HEART CLINIC" }, addresses: [{ address_purpose: "LOCATION", address_1: "2 Test Way", city: "DALLAS", state: "TX", postal_code: "75201" }], taxonomies: [{ desc: "Cardiology", primary: true }] },
    ] : [];
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ result_count: results.length, results }));
  }
  if (u.pathname === "/v1/chat/completions" && req.method === "POST") {
    let raw = ""; req.on("data", (c) => (raw += c));
    return req.on("end", () => {
      if (req.headers.authorization !== "Bearer fake-key") { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":{"message":"bad key"}}'); }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(respond(JSON.parse(raw))));
    });
  }
  if (u.pathname === "/robots.txt") { res.writeHead(200); return res.end("User-agent: *\nDisallow:\n"); }
  const pages = site("E2E Orthopedic Associates");
  const p = pages[u.pathname];
  res.writeHead(p ? 200 : 404, { "content-type": "text/html" });
  res.end(p ?? "not found");
});
await new Promise((r) => fixtures.listen(FIX, "127.0.0.1", r));

// ---- fresh database ----------------------------------------------------------------------------------
const env = {
  ...process.env,
  DATABASE_URL: DB,
  APP_BASE_URL: `http://127.0.0.1:${WEB}`,
  ADMIN_EMAIL: "founder@e2e.test", ADMIN_PASSWORD: "e2e-password-123", SESSION_SECRET: "e2e-secret-e2e-secret-e2e-secret-1234",
  NPPES_BASE_URL: `http://127.0.0.1:${FIX}/nppes/`, ALLOW_PRIVATE_FETCH: "1",
  INBOUND_WEBHOOK_SECRET: "e2e-inbound-secret", INSECURE_COOKIES: "1",
  ANTHROPIC_API_KEY: "", SMTP_URL: "", BRAVE_API_KEY: "",
  LLM_PROVIDER: "custom", LLM_BASE_URL: `http://127.0.0.1:${FIX}/v1`, AGENT_MODEL: "fake-model", LLM_API_KEY: "fake-key",
  WORKER_POLL_MS: "200", SKIP_MX_CHECK: "1", NODE_ENV: "production", PORT: String(WEB),
};
const admin = DB.replace(/\/[^/]+$/, "/postgres");
try { execFileSync("psql", [admin, "-c", "DROP DATABASE IF EXISTS rcm_e2e WITH (FORCE)"], { stdio: "ignore" }); } catch {}
execFileSync("psql", [admin, "-c", "CREATE DATABASE rcm_e2e"], { stdio: "ignore" });
execFileSync("npm", ["run", "db:migrate"], { cwd: root, env, stdio: "inherit" });

const kids = [];
const start = (cmd, args, cwd) => { const p = spawn(cmd, args, { cwd, env, stdio: "inherit" }); kids.push(p); return p; };
start("npm", ["run", "start", "-w", "@rcm/worker"], root);
start("npx", ["next", "start", "-p", String(WEB)], path.join(root, "apps/web"));

// ---- wait until the web app answers, then expose the readiness port Playwright polls --------------------
for (let i = 0; i < 120; i++) {
  try { const r = await fetch(`http://127.0.0.1:${WEB}/api/health`); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
http.createServer((_, res) => { res.writeHead(200); res.end("ready"); }).listen(READY);
const stop = () => { for (const k of kids) k.kill("SIGTERM"); fixtures.close(); setTimeout(() => process.exit(0), 500); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
