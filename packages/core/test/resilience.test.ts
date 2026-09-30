import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { query, queryOne, closePool, migrateWithRetry } from "../src/db";
import { enqueueRun } from "../src/queue";
import { processOne } from "../src/agents/worker";
import { upsertLead } from "../src/leads";
import { hasBlockingIssues, validateConfig } from "../src/config";
import { hintFor } from "../src/providers/hints";
import { postJson } from "../src/providers/http";
import { AnthropicLLM } from "../src/providers/llm";
import { BrokenMailer, DryRunMailer, MailgunMailer, PostmarkMailer, ResendMailer, SendGridMailer } from "../src/providers/mailer";
import { depsFromEnv } from "../src/agents/deps";
import { runDiagnostics, workerStatus } from "../src/diagnostics";
import { ScriptedLLM, makeDeps, readySettings, resetDb, setupDb, teardownDb } from "./helpers";

beforeAll(setupDb);
beforeEach(resetDb);
afterAll(teardownDb);

const GOOD_PROD = { NODE_ENV: "production", DATABASE_URL: "postgres://u:p@db:5432/x", ADMIN_EMAIL: "a@b.co", ADMIN_PASSWORD: "a-very-long-passphrase", SESSION_SECRET: "x".repeat(40), APP_BASE_URL: "https://crm.example.com", ANTHROPIC_API_KEY: "sk-ant-abc", RESEND_API_KEY: "re_abc", RESEND_WEBHOOK_SECRET: "whsec_abc", INBOUND_WEBHOOK_SECRET: "s", BRAVE_API_KEY: "k" };
const keys = (issues: ReturnType<typeof validateConfig>, level?: string) => issues.filter((i) => !level || i.level === level).map((i) => i.key);

describe("config validation", () => {
  it("a complete production config has no errors or warnings", () => {
    expect(validateConfig(GOOD_PROD).filter((i) => i.level !== "info")).toEqual([]);
  });
  it("flags everything that would break a production deploy, with a fix for each", () => {
    const issues = validateConfig({ NODE_ENV: "production", ALLOW_PRIVATE_FETCH: "1" });
    expect(keys(issues, "error")).toEqual(expect.arrayContaining(["DATABASE_URL", "ADMIN_PASSWORD", "SESSION_SECRET", "ALLOW_PRIVATE_FETCH", "APP_BASE_URL"]));
    expect(hasBlockingIssues(issues)).toBe(true);
    expect(issues.every((i) => i.fix.length > 10 && i.message.length > 10)).toBe(true);
  });
  it("localhost APP_BASE_URL: error in production (broken unsubscribe links), only a warning in development", () => {
    expect(validateConfig({ ...GOOD_PROD, APP_BASE_URL: "http://localhost:3000" }).find((i) => i.key === "APP_BASE_URL")!.level).toBe("error");
    expect(validateConfig({ NODE_ENV: "development", DATABASE_URL: "x", APP_BASE_URL: "http://localhost:3000" }).find((i) => i.key === "APP_BASE_URL")!.level).toBe("warn");
    expect(validateConfig({ ...GOOD_PROD, APP_BASE_URL: "not a url" }).find((i) => i.key === "APP_BASE_URL")!.level).toBe("error");
    expect(validateConfig({ ...GOOD_PROD, APP_BASE_URL: "http://crm.example.com" }).find((i) => i.key === "APP_BASE_URL")!.level).toBe("warn");
  });
  it("catches malformed keys and URLs before they cause vendor errors", () => {
    expect(keys(validateConfig({ ...GOOD_PROD, ANTHROPIC_API_KEY: "not-a-key" }))).toContain("ANTHROPIC_API_KEY");
    expect(keys(validateConfig({ ...GOOD_PROD, RESEND_API_KEY: "abc" }))).toContain("RESEND_API_KEY");
    expect(keys(validateConfig({ ...GOOD_PROD, RESEND_API_KEY: undefined, SENDGRID_API_KEY: "nope" }))).toContain("SENDGRID_API_KEY");
    expect(keys(validateConfig({ ...GOOD_PROD, RESEND_API_KEY: undefined, SMTP_URL: "smtp.host.com:465" }), "error")).toContain("SMTP_URL");
    expect(keys(validateConfig({ ...GOOD_PROD, LLM_PROVIDER: "openai", ANTHROPIC_API_KEY: undefined }), "error")).toContain("LLM_PROVIDER");
    expect(keys(validateConfig({ ...GOOD_PROD, EMAIL_PROVIDER: "postmark" }), "error")).toContain("EMAIL_PROVIDER");
    expect(keys(validateConfig({ ...GOOD_PROD, SEARCH_PROVIDER: "serper" }), "error")).toContain("SEARCH_PROVIDER");
  });
  it("warns about features that would silently not work", () => {
    expect(keys(validateConfig({ ...GOOD_PROD, RESEND_WEBHOOK_SECRET: undefined }), "warn")).toContain("RESEND_WEBHOOK_SECRET");
    expect(keys(validateConfig({ ...GOOD_PROD, RESEND_WEBHOOK_SECRET: undefined, EMAIL_WEBHOOK_SECRET: "s" }), "warn")).not.toContain("RESEND_WEBHOOK_SECRET");
    expect(keys(validateConfig({ ...GOOD_PROD, INBOUND_WEBHOOK_SECRET: undefined }), "warn")).toContain("INBOUND_WEBHOOK_SECRET");
    expect(keys(validateConfig({ ...GOOD_PROD, RESEND_API_KEY: undefined }), "warn")).toContain("EMAIL");
  });
});

describe("vendor errors explain themselves", () => {
  it("hints for the common failures", () => {
    expect(hintFor("openai", 401, "Incorrect API key provided")).toMatch(/key was rejected/);
    expect(hintFor("resend", 403, "The domain is not verified")).toMatch(/resend\.com\/domains/);
    expect(hintFor("resend", 403, "You can only send testing emails to your own email address")).toMatch(/verified domain/);
    expect(hintFor("sendgrid", 403, "The from address does not match a verified Sender Identity")).toMatch(/Sender Verification/);
    expect(hintFor("postmark", 422, "Sender signature not confirmed")).toMatch(/Sender Signature/);
    expect(hintFor("mailgun", 403, "Sandbox subdomains are for test purposes only. Please add your own domain or add the address to authorized recipients")).toMatch(/Authorized Recipients/);
    expect(hintFor("anthropic", 404, "model: claude-x not found")).toMatch(/AGENT_MODEL/);
    expect(hintFor("openai", 429, "You exceeded your current quota, please check your plan and billing details")).toMatch(/Billing/);
    expect(hintFor("gemini", 429, "rate")).toMatch(/Rate limit/);
    expect(hintFor("x", 503, "")).toMatch(/retry automatically/);
    expect(hintFor("x", 418, "teapot")).toBeNull();
  });
  it("postJson appends the hint to the error; Anthropic SDK errors get one too", async () => {
    const f = (async () => new Response(JSON.stringify({ message: "The domain is not verified" }), { status: 403 })) as any;
    await expect(postJson("https://api.resend.com/emails", {}, {}, { fetchImpl: f, retryDelaysMs: [], label: "resend" })).rejects.toThrow(/403.*not verified[\s\S]*→ Resend only sends from a verified domain/);
    const client = { messages: { create: async () => { throw Object.assign(new Error("invalid x-api-key"), { status: 401 }); } } } as any;
    await expect(new AnthropicLLM(client, "m").json({ system: "s", prompt: "p", schema: z.object({}) })).rejects.toThrow(/anthropic API error 401[\s\S]*→ The API key was rejected/);
    await expect(new AnthropicLLM(client, "m").converse({ system: "s", messages: [{ role: "user", content: "x" }], tools: [], onTool: async () => "" })).rejects.toThrow(/→/);
  });
});

describe("misconfiguration never crashes the worker or fakes a delivery", () => {
  it("depsFromEnv degrades instead of throwing, and logs why", () => {
    const logs: string[] = [];
    const d = depsFromEnv({ LLM_PROVIDER: "nonsense", LLM_API_KEY: "k", EMAIL_PROVIDER: "sendgrid", SEARCH_PROVIDER: "serper" }, (m) => logs.push(m));
    expect(d.llm).toBeNull();
    expect(d.mailer).toBeInstanceOf(BrokenMailer);
    expect(logs.join("\n")).toMatch(/AI provider disabled: Unknown LLM_PROVIDER/);
    expect(logs.join("\n")).toMatch(/Email provider misconfigured.*SENDGRID_API_KEY/);
    expect(logs.join("\n")).toMatch(/Web search disabled.*SERPER_API_KEY/);
    expect(depsFromEnv({}, () => {}).mailer).toBeInstanceOf(DryRunMailer);
  });
  it("a misconfigured mailer makes sends fail loudly (approved stays approved, then 'failed' with the reason), never 'sent'", async () => {
    await readySettings({ sendWindowStartHour: 0, sendWindowEndHour: 24, sendOnWeekends: true });
    const { leadId } = await upsertLead({ name: "Broken Mail Clinic" });
    const m = await queryOne<any>("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, unsub_token) VALUES ($1,'outbound',1,'a@b.test','s','b','approved','tk') RETURNING id", [leadId]);
    const deps = makeDeps({ mailer: new BrokenMailer("RESEND_API_KEY is missing") as any });
    const run = await enqueueRun({ kind: "send", input: { messageId: m.id }, maxAttempts: 2 });
    await processOne("t", deps);
    let row = (await queryOne<any>("SELECT status, error FROM messages WHERE id = $1", [m.id]))!;
    expect(row.status).toBe("approved");
    expect(row.error).toMatch(/misconfigured: RESEND_API_KEY is missing/);
    await query("UPDATE agent_runs SET run_at = now() WHERE id = $1", [run.id]);
    await processOne("t", deps);
    row = (await queryOne<any>("SELECT status, error FROM messages WHERE id = $1", [m.id]))!;
    expect(row.status).toBe("failed");
    expect((await queryOne<any>("SELECT status, error FROM agent_runs WHERE id = $1", [run.id]))!.status).toBe("failed");
  });
  it("migrateWithRetry waits for a database that is not up yet, then gives a clear error", async () => {
    const saved = process.env.DATABASE_URL;
    await closePool();
    process.env.DATABASE_URL = "postgres://rcm:rcm@127.0.0.1:1/nothing";
    const logs: string[] = [];
    try { await expect(migrateWithRetry(3, 1, (m) => logs.push(m))).rejects.toThrow(/Database not usable after 3 attempt.*Check DATABASE_URL/); }
    finally { await closePool(); process.env.DATABASE_URL = saved; }
    expect(logs).toHaveLength(2);
  });
});

describe("email provider connection checks (never send mail)", () => {
  const j = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const mk = (r: Response) => { const calls: any[] = []; return { calls, f: (async (u: string, i: any) => { calls.push({ u, i }); return r; }) as any }; };

  it("Resend: verified / unverified / missing domain, sending-only key, bad key", async () => {
    const list = { data: [{ name: "good.com", status: "verified" }, { name: "pending.com", status: "pending" }] };
    let m = mk(j(list));
    expect(await new ResendMailer("k", { fetchImpl: m.f }).check("sam@good.com")).toMatchObject({ ok: true });
    expect(m.calls[0].u).toBe("https://api.resend.com/domains");
    expect(m.calls[0].i.headers.authorization).toBe("Bearer k");
    expect(await new ResendMailer("k", { fetchImpl: mk(j(list)).f }).check("sam@pending.com")).toMatchObject({ ok: false, detail: expect.stringContaining("pending") });
    expect(await new ResendMailer("k", { fetchImpl: mk(j(list)).f }).check("sam@other.com")).toMatchObject({ ok: false, detail: expect.stringContaining("not in this Resend account") });
    expect(await new ResendMailer("k", { fetchImpl: mk(j({ name: "restricted_api_key", message: "This API key is restricted to only send emails" }, 401)).f }).check("sam@good.com")).toMatchObject({ ok: true, detail: expect.stringContaining("sending-only") });
    expect(await new ResendMailer("k", { fetchImpl: mk(j({ name: "invalid_api_key" }, 403)).f }).check()).toMatchObject({ ok: false });
  });
  it("SendGrid: needs mail.send", async () => {
    expect(await new SendGridMailer("k", { fetchImpl: mk(j({ scopes: ["mail.send", "alerts.read"] })).f }).check()).toMatchObject({ ok: true });
    expect(await new SendGridMailer("k", { fetchImpl: mk(j({ scopes: ["alerts.read"] })).f }).check()).toMatchObject({ ok: false, detail: expect.stringContaining("mail.send") });
    expect(await new SendGridMailer("k", { fetchImpl: mk(j({}, 401)).f }).check()).toMatchObject({ ok: false });
    const m = mk(j({ scopes: ["mail.send"] })); await new SendGridMailer("k", { fetchImpl: m.f }, "https://api.eu.sendgrid.com").check();
    expect(m.calls[0].u).toBe("https://api.eu.sendgrid.com/v3/scopes");
  });
  it("Postmark and Mailgun", async () => {
    const pm = mk(j({ Name: "My Server" }));
    expect(await new PostmarkMailer("t", "outbound", { fetchImpl: pm.f }).check("a@b.co")).toMatchObject({ ok: true, detail: expect.stringContaining("My Server") });
    expect(pm.calls[0].i.headers["x-postmark-server-token"]).toBe("t");
    expect(await new PostmarkMailer("t", "outbound", { fetchImpl: mk(j({}, 401)).f }).check()).toMatchObject({ ok: false });
    expect(await new MailgunMailer("k", "mg.co", "us", mk(j({ domain: { state: "active" } })).f).check()).toMatchObject({ ok: true });
    expect(await new MailgunMailer("k", "mg.co", "us", mk(j({ domain: { state: "unverified" } })).f).check()).toMatchObject({ ok: false });
    expect(await new MailgunMailer("k", "mg.co", "eu", mk(j({}, 404)).f).check()).toMatchObject({ ok: false, hint: expect.stringContaining("MAILGUN_REGION") });
    expect(await new MailgunMailer("k", "mg.co", "us", mk(j({}, 401)).f).check()).toMatchObject({ ok: false });
    expect(await new BrokenMailer("nope").check()).toMatchObject({ ok: false, detail: "nope" });
    expect((await new DryRunMailer().check()).detail).toMatch(/dry-run/);
  });
});

describe("diagnostics", () => {
  it("worker heartbeat: absent, fresh, stale; counts waiting jobs", async () => {
    expect((await workerStatus()).alive).toBe(false);
    await enqueueRun({ kind: "smoke" });
    expect(await workerStatus()).toMatchObject({ alive: false, queued: 1 });
    const s = await enqueueRun({ kind: "sweep", idempotencyKey: "x" });
    expect((await workerStatus()).alive).toBe(true);
    await query("UPDATE agent_runs SET created_at = now() - interval '10 minutes' WHERE id = $1", [s.id]);
    expect((await workerStatus()).alive).toBe(false);
  });

  it("quick check flags a missing worker with a fix; passes when it is alive", async () => {
    const r1 = await runDiagnostics(makeDeps(), { env: GOOD_PROD });
    const w = r1.find((c) => c.name === "Background worker")!;
    expect(w.status).toBe("fail");
    expect(w.hint).toMatch(/npm run start -w @rcm\/worker/);
    expect(r1.find((c) => c.name === "Database")!.status).toBe("pass");
    await enqueueRun({ kind: "sweep", idempotencyKey: "hb" });
    expect((await runDiagnostics(makeDeps(), { env: GOOD_PROD })).find((c) => c.name === "Background worker")!.status).toBe("pass");
  });

  it("full test runs every live check, reports failures with hints, and never sends mail", async () => {
    await enqueueRun({ kind: "sweep", idempotencyKey: "hb" });
    await readySettings();
    process.env.APP_BASE_URL = "http://localhost:3000";
    const llm = new ScriptedLLM({ json: () => ({ name: "Jane Smith", title: "Practice Manager" }), converse: async (o) => { await o.onTool("pipeline_stats", {}); return { text: "42 leads", usage: { tokensIn: 5, tokensOut: 5 }, steps: 2 }; } });
    const deps = makeDeps({
      llm,
      npi: { search: async () => [{ name: "Test Ortho", city: "Austin", state: "TX" }] } as any,
      web: { fetchPage: async () => ({ url: "https://example.com", status: 200, title: "Example", text: "hi", links: [], emails: [] }), search: async () => [] } as any,
      mxCheck: async (d: string) => d === "gmail.com",
    });
    try {
      const res = await runDiagnostics(deps, { deep: true, env: { ...GOOD_PROD, BRAVE_API_KEY: "k" } });
      const by = (n: string) => res.find((c) => c.name.startsWith(n))!;
      expect(by("Public URL").status).toBe("warn");
      expect(by("AI model scripted: structured").status).toBe("pass");
      expect(by("AI model scripted: tool").status).toBe("pass");
      expect(by("Lead registry").status).toBe("pass");
      expect(by("Website fetching").status).toBe("pass");
      expect(by("Web search").status).toBe("fail");
      expect(by("Web search").hint).toMatch(/quota/);
      expect(by("Email-domain").status).toBe("pass");
      expect(by("Email provider").status).toBe("warn"); // dry-run
      expect(deps.mailer.outbox).toHaveLength(0);
      // a broken AI provider is reported with the vendor's hint, not thrown
      const bad = new ScriptedLLM({ json: () => { throw new Error("anthropic API error 401: invalid x-api-key\n→ The API key was rejected. Re-copy the full key."); } });
      const res2 = await runDiagnostics(makeDeps({ llm: bad, npi: deps.npi, web: deps.web }), { deep: true, env: GOOD_PROD });
      const ai = res2.find((c) => c.name.includes("structured"))!;
      expect(ai).toMatchObject({ status: "fail", detail: expect.stringContaining("401"), hint: expect.stringContaining("key was rejected") });
    } finally { process.env.APP_BASE_URL = "http://app.test"; }
  });
});
