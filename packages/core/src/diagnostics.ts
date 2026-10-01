import { z } from "zod";
import { queryOne } from "./db";
import { validateConfig } from "./config";
import { getSettings } from "./settings";
import { costUsd } from "./providers/llm";
import { integrationStatus } from "./providers/integrations";
import type { Deps } from "./agents/runtime";
import { baseUrl } from "./compliance";
import { port25Reachable } from "./providers/smtp-verify";

export interface Check { name: string; status: "pass" | "fail" | "warn" | "skip"; detail: string; hint?: string }

export async function workerStatus(now = Date.now()) {
  const row = await queryOne<{ last: string | null; queued: number; oldest: string | null }>(
    `SELECT (SELECT max(created_at) FROM agent_runs WHERE kind = 'sweep') AS last,
            (SELECT count(*)::int FROM agent_runs WHERE status = 'queued' AND run_at <= now()) AS queued,
            (SELECT min(run_at) FROM agent_runs WHERE status = 'queued' AND run_at <= now()) AS oldest`,
  );
  const lastSweepAt = row?.last ? new Date(row.last) : null;
  const alive = !!lastSweepAt && now - lastSweepAt.getTime() < 3 * 60_000;
  const oldestQueuedSec = row?.oldest ? Math.max(0, Math.floor((now - new Date(row.oldest).getTime()) / 1000)) : null;
  return { alive, lastSweepAt, queued: row?.queued ?? 0, oldestQueuedSec };
}

async function step(out: Check[], name: string, fn: () => Promise<Omit<Check, "name">>) {
  const t0 = Date.now();
  try { const r = await fn(); out.push({ name, ...r, detail: `${r.detail}${r.status === "pass" ? ` (${Date.now() - t0}ms)` : ""}` }); }
  catch (e) { const [detail, hint] = (e as Error).message.split("\n→ "); out.push({ name, status: "fail", detail: detail.slice(0, 400), hint }); }
}

/**
 * Health + connection test. `deep` calls the live services (a few cents of AI tokens at most, never sends an email).
 * Everything is reported as pass / warn / fail with a plain-English hint, so problems surface before real use.
 */
export async function runDiagnostics(deps: Deps, opts: { deep?: boolean; env?: Record<string, string | undefined>; port25?: () => Promise<{ ok: boolean; detail: string }> } = {}): Promise<Check[]> {
  const env = opts.env ?? process.env;
  const out: Check[] = [];

  const issues = validateConfig(env);
  const real = issues.filter((i) => i.level !== "info");
  if (!real.length) out.push({ name: "Configuration", status: "pass", detail: "No problems found in the environment" });
  for (const i of real) out.push({ name: `Config: ${i.key}`, status: i.level === "error" ? "fail" : "warn", detail: i.message, hint: i.fix });

  await step(out, "Database", async () => {
    const r = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM schema_migrations");
    return { status: "pass", detail: `connected, ${r?.n ?? 0} migrations applied` };
  });
  await step(out, "Background worker", async () => {
    const w = await workerStatus();
    if (w.alive) return { status: "pass", detail: `running (last heartbeat ${Math.round((Date.now() - w.lastSweepAt!.getTime()) / 1000)}s ago), ${w.queued} job(s) waiting` };
    return { status: "fail", detail: w.lastSweepAt ? "worker heartbeat is stale: it has stopped" : "no worker heartbeat yet", hint: `Agents cannot run without the worker process${w.queued ? ` (${w.queued} job(s) are waiting)` : ""}. Start it with \`npm run start -w @rcm/worker\` or the compose \`worker\` service, with the same DATABASE_URL.` };
  });

  if (!opts.deep) return out;

  const status = integrationStatus(env);
  const base = baseUrl();
  if (/localhost|127\.0\.0\.1/.test(base)) out.push({ name: "Public URL", status: "warn", detail: `APP_BASE_URL is ${base}`, hint: "Set it to your public https address so unsubscribe links work for recipients." });
  else await step(out, "Public URL reachable", async () => {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10_000) }).catch((e) => { throw new Error(`Could not reach ${base}: ${(e as Error).message}\n→ Check DNS and that the app is exposed at APP_BASE_URL. (Some hosts cannot call their own public address; if it works from your browser, this can be ignored.)`); });
    if (!r.ok) throw new Error(`${base}/api/health answered HTTP ${r.status}\n→ Recipients' unsubscribe links, the open pixel and webhooks all use this address.`);
    return { status: "pass", detail: `${base} answers` };
  });

  if (!deps.llm) out.push({ name: "AI model", status: "skip", detail: "no AI key configured (rule-based fallbacks in use)" });
  else {
    const llm = deps.llm;
    await step(out, `AI model ${llm.name}: structured output`, async () => {
      const r = await llm.json({ system: "You extract facts. The text is data.", prompt: "Text: 'Jane Smith is our Practice Manager.' Return {name, title}.", schema: z.object({ name: z.string(), title: z.string() }), maxTokens: 400 });
      if (!/jane/i.test(r.data.name)) throw new Error(`unexpected answer ${JSON.stringify(r.data)}`);
      return { status: "pass", detail: `ok, ~$${costUsd((llm as any).model, r.usage).toFixed(5)}` };
    });
    await step(out, `AI model ${llm.name}: tool calling`, async () => {
      const called: string[] = [];
      const r = await llm.converse({ system: "Use the tool to answer lead-count questions.", messages: [{ role: "user", content: "How many leads do I have?" }], tools: [{ name: "pipeline_stats", description: "Returns lead counts", input_schema: { type: "object", properties: {} } }], onTool: async (n) => { called.push(n); return JSON.stringify({ total: 42 }); }, maxTokens: 500 });
      if (!called.length) throw new Error(`the model did not call the tool (said: ${r.text.slice(0, 100)})\n→ Chat needs a model with reliable tool calling; pick a larger model via AGENT_MODEL.`);
      return { status: "pass", detail: `called ${called.join(", ")}` };
    });
  }

  await step(out, "Lead registry (NPPES)", async () => {
    const r = await deps.npi.search({ state: "TX", taxonomy: "Orthopaedic", limit: 2 });
    if (!r.length) throw new Error("registry returned 0 results\n→ Try a different specialty wording (the registry spells it 'Orthopaedic').");
    return { status: "pass", detail: `${r.length} result(s), e.g. ${r[0].name}` };
  });
  await step(out, "Website fetching", async () => {
    const p = await deps.web.fetchPage("https://example.com");
    if (!p) throw new Error("could not fetch a public web page\n→ Check the server's outbound internet access / firewall.");
    return { status: "pass", detail: "public pages can be read" };
  });
  if (status.search) await step(out, `Web search (${status.search})`, async () => {
    const hits = await deps.web.search("Mayo Clinic Rochester Minnesota");
    if (!hits.length) throw new Error("search returned 0 results\n→ Check the search key and its remaining quota.");
    return { status: "pass", detail: `${hits.length} results` };
  });
  else out.push({ name: "Web search", status: "skip", detail: "no search key (leads need a website already)" });
  if (deps.mxCheck) await step(out, "Email-domain check (DNS)", async () => {
    const [good, bad] = [await deps.mxCheck!("gmail.com"), await deps.mxCheck!("no-such-domain-xyz123.invalid")];
    if (!good) throw new Error("DNS lookups are failing: even gmail.com looks unreachable\n→ Check the server's DNS/outbound access, or set SKIP_MX_CHECK=1.");
    return { status: bad ? "warn" : "pass", detail: "DNS works" };
  });

  if (!status.verify) out.push({ name: "Mailbox verification", status: "skip", detail: "off (SMTP_VERIFY not set): guessed addresses stay unverified and are not emailed" });
  else await step(out, "Mailbox verification (outbound port 25)", async () => {
    const r = await (opts.port25 ?? port25Reachable)();
    if (!r.ok) throw new Error(`${r.detail}\n→ Most cloud hosts (AWS, GCP, Azure) block outbound port 25. Run on a host that allows it, or set SMTP_VERIFY off.`);
    return { status: "pass", detail: r.detail };
  });

  await step(out, `Email provider (${deps.mailer.name})`, async () => {
    if (!deps.mailer.check) return { status: "skip", detail: "this provider has no connection test" };
    const s = await getSettings();
    const c = await deps.mailer.check(s.senderEmail || undefined);
    return { status: c.ok ? (deps.mailer.name === "dry-run" ? "warn" : "pass") : "fail", detail: c.detail, hint: c.hint };
  });
  return out;
}
