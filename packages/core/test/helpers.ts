import http from "node:http";
import { AddressInfo } from "node:net";
import { closePool, migrate, query } from "../src/db";
import { DryRunMailer } from "../src/providers/mailer";
import { HttpWebTools } from "../src/providers/web";
import type { Deps } from "../src/agents/runtime";
import type { LLM } from "../src/providers/llm";
import type { NpiClient } from "../src/providers/npi";
import { saveSettings } from "../src/settings";

export async function setupDb() {
  await migrate();
}
export async function resetDb() {
  await query(
    "TRUNCATE organizations, contacts, leads, research_profiles, messages, suppressions, agent_runs, agent_events, chat_messages, settings, audit_log, email_events, email_patterns, tasks, deals RESTART IDENTITY CASCADE",
  );
}
export async function teardownDb() {
  await closePool();
}

export async function readySettings(over: Record<string, unknown> = {}) {
  return saveSettings({
    senderName: "Sam Rivers",
    senderEmail: "sam@kangguircm.test",
    companyName: "Kangguircm",
    physicalAddress: "100 Main St, Suite 5, Austin, TX 78701",
    ...over,
  } as any);
}

export class FakeNpi implements NpiClient {
  calls: any[] = [];
  constructor(private data: any[]) {}
  async search(q: any) {
    this.calls.push(q);
    return this.data.slice(q.skip ?? 0, (q.skip ?? 0) + (q.limit ?? 50));
  }
}

export function makeDeps(over: Partial<Deps> = {}): Deps & { mailer: DryRunMailer } {
  return {
    llm: null,
    npi: new FakeNpi([]),
    web: new HttpWebTools({ allowPrivate: true, respectRobots: true }),
    mailer: new DryRunMailer(),
    domainGuess: false, // hermetic: tests must not guess real domains on the internet
    ...over,
  } as any;
}

/** Serves a tiny fake practice website on localhost. */
export async function startSite(pages: Record<string, string>) {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("User-agent: *\nDisallow: /private\n");
    }
    const html = pages[path];
    if (!html) { res.writeHead(404, { "content-type": "text/html" }); return res.end("nope"); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export class ScriptedLLM implements LLM {
  name = "scripted";
  model = "claude-opus-5-5";
  jsonCalls: { system: string; prompt: string }[] = [];
  constructor(private opts: { json?: (prompt: string, n: number, system: string) => unknown; converse?: LLM["converse"] }) {}
  async json(o: any) {
    this.jsonCalls.push({ system: o.system, prompt: o.prompt });
    const raw = this.opts.json?.(o.prompt, this.jsonCalls.length, o.system);
    return { data: o.schema.parse(raw), usage: { tokensIn: 1000, tokensOut: 500 } };
  }
  async converse(o: any) {
    if (!this.opts.converse) throw new Error("no converse script");
    return this.opts.converse(o);
  }
}

export const TEAM_HTML = `<html><head><title>Riverside Orthopedics</title></head><body>
<h1>Riverside Orthopedics</h1>
<a href="/about">About</a> <a href="/team">Our Team</a> <a href="/private/admin">Admin</a> <a href="/contact">Contact</a> <a href="/blog">Blog</a>
<p>We accept Medicare, Medicaid and most major insurance. Three convenient locations. We use athenahealth for patient records.</p>
<p>Now hiring: medical biller for our billing department.</p>
</body></html>`;
export const PAGES: Record<string, string> = {
  "/": TEAM_HTML,
  "/about": `<html><body><h2>About</h2><p>Dr. Alan Weber and Dr. Priya Nair lead a group of orthopedic surgeons. Dr. Lee Cho, MD joins us. Prior authorization is handled by our front desk.</p></body></html>`,
  "/team": `<html><body><h2>Our Team</h2>
    <div><strong>Jane Smith</strong><br>Practice Manager</div>
    <div>Robert Alvarez, Billing Manager</div>
    <div>Dr. Alan Weber - Medical Director</div>
    <p>Reach Jane at <a href="mailto:jane.smith@riverside-ortho.test">jane.smith@riverside-ortho.test</a></p></body></html>`,
  "/staff-directory": `<html><body><h2>Staff Directory</h2><div>Robert Alvarez, Billing Manager</div><a href="mailto:ralvarez@riverside-ortho.test">Email Robert</a></body></html>`,
  "/contact": `<html><body>Contact us: <a href="mailto:info@riverside-ortho.test">info@riverside-ortho.test</a> Phone 512-555-0100</body></html>`,
  "/private/admin": `<html><body>secret@riverside-ortho.test</body></html>`,
};
