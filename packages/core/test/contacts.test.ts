import net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "../src/db";
import { enqueueRun, getRun } from "../src/queue";
import { processOne } from "../src/agents/worker";
import { addContact, getContacts, getLead, upsertLead } from "../src/leads";
import { saveSettings } from "../src/settings";
import { candidates, inferPattern, learnFromPairs, parseName, render } from "../src/providers/email-patterns";
import { createSmtpVerifier, port25Reachable } from "../src/providers/smtp-verify";
import { domainCandidates, findDomain, scoreSite } from "../src/agents/domain-finder";
import { pickContact } from "../src/agents/outreach";
import { PAGES, makeDeps, readySettings, resetDb, setupDb, startSite, teardownDb } from "./helpers";

beforeAll(setupDb);
beforeEach(resetDb);
afterAll(teardownDb);
const drain = async (deps: any) => { let n = 0; while (n < 40 && (await processOne("t", deps))) n++; };

describe("email pattern engine", () => {
  it("parses names: titles, credentials, middle initials, suffixes, accents, hyphens", () => {
    expect(parseName("Dr. Huong T. Le, MD")).toEqual({ first: "huong", last: "le" });
    expect(parseName("Jennifer Kinman")).toEqual({ first: "jennifer", last: "kinman" });
    expect(parseName("José Núñez-Pérez Jr.")).toEqual({ first: "jose", last: "nunezperez" });
    expect(parseName("Ana O'Neil (Practice Manager)")).toEqual({ first: "ana", last: "oneil" });
    expect(parseName("Cher")).toBeNull();
    expect(parseName("MD")).toBeNull();
    expect(parseName(null)).toBeNull();
  });
  it("renders and ranks candidates: learned patterns first, no duplicates", () => {
    const c = candidates("Jane Smith", "Practice.com");
    expect(c.slice(0, 3).map((x) => x.email)).toEqual(["jane.smith@practice.com", "jsmith@practice.com", "jane@practice.com"]);
    expect(new Set(c.map((x) => x.email)).size).toBe(c.length);
    const l = candidates("Jane Smith", "practice.com", ["flast"]);
    expect(l[0]).toMatchObject({ email: "jsmith@practice.com", learned: true });
    expect(render("lastf", { first: "jane", last: "smith" })).toBe("smithj");
    expect(candidates("Cher", "x.com")).toEqual([]);
  });
  it("infers and learns patterns from known pairs", () => {
    expect(inferPattern("jsmith@x.com", "Jane Smith")).toBe("flast");
    expect(inferPattern("jane.smith@x.com", "Dr. Jane Smith, MD")).toBe("first.last");
    expect(inferPattern("info@x.com", "Jane Smith")).toBeNull();
    expect(learnFromPairs([{ name: "Ann Brown", email: "abrown@x.com" }, { name: "Cy Davis", email: "cdavis@x.com" }, { name: "Eve Fox", email: "eve.fox@x.com" }])).toEqual(["flast", "first.last"]);
  });
});

// ---- fake SMTP server -------------------------------------------------------------------------------
interface Behavior { users?: string[]; catchAll?: boolean; rcpt?: string; greeting?: string; multiline?: boolean }
async function fakeSmtp(b: Behavior = {}) {
  const log: string[] = [];
  let conns = 0, active = 0, maxActive = 0;
  const server = net.createServer((sock) => {
    conns++; active++; maxActive = Math.max(maxActive, active);
    sock.on("close", () => active--);
    sock.setEncoding("utf8");
    sock.write(b.greeting ?? "220 fake.test ESMTP ready\r\n");
    let buf = "";
    sock.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        log.push(line);
        const up = line.toUpperCase();
        if (up.startsWith("EHLO")) sock.write(b.multiline === false ? "250 fake.test\r\n" : "250-fake.test\r\n250-PIPELINING\r\n250 SIZE 1000\r\n");
        else if (up.startsWith("HELO")) sock.write("250 fake.test\r\n");
        else if (up.startsWith("MAIL FROM")) sock.write("250 2.1.0 ok\r\n");
        else if (up.startsWith("RCPT TO")) {
          const addr = line.match(/<([^>]+)>/)![1].toLowerCase();
          if (b.rcpt) sock.write(b.rcpt + "\r\n");
          else if (b.catchAll || b.users?.includes(addr)) sock.write("250 2.1.5 ok\r\n");
          else sock.write("550 5.1.1 <" + addr + ">: Recipient address rejected: User unknown\r\n");
        } else if (up === "RSET") sock.write("250 ok\r\n");
        else if (up === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else if (up === "DATA") sock.write("354 go ahead\r\n");
        else sock.write("500 unknown\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, log, stats: () => ({ conns, maxActive }), close: () => new Promise<void>((r) => server.close(() => r())) };
}
const verifierFor = (port: number, mx = "127.0.0.1", extra: any = {}) => createSmtpVerifier({ heloDomain: "me.test", mailFrom: "verify@me.test", port, timeoutMs: 1500, perHostDelayMs: 0, resolveMx: async () => [{ exchange: mx, priority: 10 }], ...extra });

describe("SMTP mailbox verifier (against a real fake SMTP server over TCP)", () => {
  it("valid mailbox (and never sends a message)", async () => {
    const s = await fakeSmtp({ users: ["huong.le@x.test"] });
    const r = await verifierFor(s.port)("Huong.Le@X.test");
    expect(r).toMatchObject({ status: "valid", code: 250 });
    expect(s.log).toContain("EHLO me.test");
    expect(s.log).toContain("MAIL FROM:<verify@me.test>");
    expect(s.log).toContain("RCPT TO:<huong.le@x.test>");
    expect(s.log.some((l) => /^DATA/i.test(l))).toBe(false); // hangs up without sending anything
    expect(s.log).toContain("QUIT");
    await s.close();
  });
  it("invalid mailbox (550 5.1.1)", async () => {
    const s = await fakeSmtp({ users: [] });
    expect(await verifierFor(s.port)("nobody@x.test")).toMatchObject({ status: "invalid", code: 550 });
    await s.close();
  });
  it("catch-all server is detected", async () => {
    const s = await fakeSmtp({ catchAll: true });
    const r = await verifierFor(s.port)("anyone@x.test");
    expect(r.status).toBe("catch-all");
    expect(s.log.filter((l) => l.startsWith("RCPT")).length).toBe(2); // real address + random probe
    await s.close();
  });
  it("greylisting, policy blocks and refusals are 'unknown', never 'valid'", async () => {
    for (const [rcpt, why] of [["451 4.7.1 Greylisted, try again later", /451/], ["550 5.7.1 Blocked by policy", /550/], ["421 service not available", /421/]] as const) {
      const s = await fakeSmtp({ rcpt });
      const r = await verifierFor(s.port)("a@x.test");
      expect(r.status, rcpt).toBe("unknown");
      expect(r.reason).toMatch(why);
      await s.close();
    }
    const s = await fakeSmtp({ greeting: "554 no service for you\r\n" });
    expect((await verifierFor(s.port)("a@x.test")).status).toBe("unknown");
    await s.close();
  });
  it("mailbox full (552) means it exists", async () => {
    const s = await fakeSmtp({ rcpt: "552 5.2.2 Mailbox full" });
    expect((await verifierFor(s.port)("a@x.test")).status).toBe("valid");
    await s.close();
  });
  it("single-line EHLO replies and HELO fallback work", async () => {
    const s = await fakeSmtp({ users: ["a@x.test"], multiline: false });
    expect((await verifierFor(s.port)("a@x.test")).status).toBe("valid");
    await s.close();
  });
  it("blocked port 25 / nothing listening / timeout → unknown with a reason", async () => {
    const closed = await fakeSmtp(); const port = closed.port; await closed.close();
    const r = await verifierFor(port)("a@x.test");
    expect(r.status).toBe("unknown");
    expect(r.reason).toMatch(/cannot connect/);
    const silent = net.createServer(() => { /* accepts, says nothing */ }); await new Promise<void>((res) => silent.listen(0, "127.0.0.1", res));
    const t = await verifierFor((silent.address() as net.AddressInfo).port, "127.0.0.1", { timeoutMs: 200 })("a@x.test");
    expect(t).toMatchObject({ status: "unknown", reason: expect.stringMatching(/timeout|cannot connect/) });
    silent.close();
  });
  it("short-circuits: malformed, freemail, mail gateways, DNS failures", async () => {
    const v = verifierFor(1, "mx.pphosted.com");
    expect((await v("not-an-email")).status).toBe("invalid");
    expect((await v("someone@gmail.com")).reason).toMatch(/freemail/);
    expect(await v("a@corp.test")).toMatchObject({ status: "unknown", reason: expect.stringMatching(/gateway.*accepts all/) });
    const nx = createSmtpVerifier({ heloDomain: "h", mailFrom: "f@h", resolveMx: async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); } });
    expect(await nx("a@nope.test")).toMatchObject({ status: "invalid", reason: expect.stringMatching(/no mail server/) });
    const slow = createSmtpVerifier({ heloDomain: "h", mailFrom: "f@h", resolveMx: async () => { throw Object.assign(new Error("t"), { code: "ETIMEOUT" }); } });
    expect((await slow("a@x.test")).status).toBe("unknown");
    expect((await createSmtpVerifier({ heloDomain: "h", mailFrom: "f@h", resolveMx: async () => [] })("a@x.test")).status).toBe("invalid");
  });
  it("caches definitive answers, and serializes probes to the same mail server", async () => {
    const s = await fakeSmtp({ users: ["a@x.test", "b@x.test", "c@x.test"] });
    const v = verifierFor(s.port);
    await v("a@x.test"); await v("a@x.test");
    expect(s.stats().conns).toBe(1); // second answer came from the cache
    await Promise.all([v("b@x.test"), v("c@x.test")]);
    expect(s.stats().maxActive).toBe(1); // never two simultaneous connections to one server
    await s.close();
  });
  it("port25Reachable reports a refused connection clearly", async () => {
    const s = await fakeSmtp(); const port = s.port; await s.close();
    const r = await new Promise<{ ok: boolean; detail: string }>((res) => { const c = net.connect({ host: "127.0.0.1", port }); c.once("error", (e) => res({ ok: false, detail: e.message })); });
    expect(r.ok).toBe(false);
    expect(typeof port25Reachable).toBe("function");
  });
});

describe("domain finder", () => {
  it("candidate domains from legal names and DBAs (cleaned, deduplicated, capped)", () => {
    const c = domainCandidates(["Riverside Orthopedic Associates, PLLC", "Texas Orthopedics, Sports & Rehabilitation Associates"]);
    expect(c).toEqual(expect.arrayContaining(["riversideorthopedicassociates.com", "riversideorthopedic.com"]));
    expect(c).toContain("texasorthopedics.com");
    expect(c.every((d) => /^[a-z0-9]+\.(com|org|net|health|md)$/.test(d))).toBe(true);
    expect(c.length).toBeLessThanOrEqual(12);
    expect(new Set(c).size).toBe(c.length);
    expect(domainCandidates(["LLC"])).toEqual([]);
  });
  const org = { name: "Riverside Orthopedic Associates, PLLC", city: "Austin", state: "TX", phone: "512-555-0100", aliases: [] as string[] };
  it("scores: phone match + name + city is strong; parked pages and strangers are not", () => {
    const good = scoreSite({ title: "Riverside Orthopedic", text: "Riverside Orthopedic in Austin, TX. Call (512) 555-0100. Our physicians treat patients." }, org);
    expect(good.score).toBeGreaterThanOrEqual(90);
    expect(good.reasons).toEqual(expect.arrayContaining(["phone number matches", "city"]));
    expect(scoreSite({ title: "Riverside Bakery", text: "Fresh bread in Dallas. patients welcome" }, org).score).toBeLessThan(60);
    expect(scoreSite({ title: "riversideorthopedic.com", text: "This domain is for sale. Buy this domain today." }, org).score).toBe(0);
  });
  const web = (pages: Record<string, { title: string; text: string }>, hits: any[] = []) => ({
    fetchPage: async (u: string) => { const p = pages[new URL(u).origin]; return p ? { url: u, status: 200, title: p.title, text: p.text, links: [], emails: [] } : null; },
    search: async () => hits,
  });
  it("accepts a guessed domain only with strong evidence; rejects look-alikes", async () => {
    const w = web({ "https://riversideorthopedic.com": { title: "Riverside Orthopedic", text: "Austin TX (512) 555-0100 patients" }, "https://riversideorthopedicassociates.com": { title: "Other", text: "unrelated" } });
    expect(await findDomain(w as any, org)).toMatchObject({ website: "https://riversideorthopedic.com", via: "guess" });
    expect(await findDomain(web({ "https://riversideorthopedic.com": { title: "Riverside Orthopedic Supply", text: "We sell supplies in Dallas" } }) as any, org)).toBeNull();
    expect(await findDomain(w as any, org, undefined, { guess: false })).toBeNull();
  });
  it("prefers the search provider's result when it checks out", async () => {
    const w = web({ "https://riversideortho.example": { title: "Riverside Orthopedic Associates", text: "Austin, TX 512-555-0100 patients physicians" } }, [{ title: "x", url: "https://www.healthgrades.com/p", snippet: "" }, { title: "Riverside", url: "https://riversideortho.example/about", snippet: "" }]);
    expect(await findDomain(w as any, org)).toMatchObject({ website: "https://riversideortho.example", via: "search" });
  });
});

describe("contacts agent", () => {
  const verifierWith = (valid: string[], mode: "ok" | "catch" | "unknown" | "invalid" = "ok") => async (email: string) =>
    mode === "catch" ? { status: "catch-all" as const, reason: "accepts any" } : mode === "unknown" ? { status: "unknown" as const, reason: "greylisted" } : valid.includes(email) ? { status: "valid" as const, reason: "ok" } : { status: "invalid" as const, reason: "no such user" };
  async function org(website: string | null = "https://riverside-ortho.test") {
    await readySettings({ sendWindowStartHour: 0, sendWindowEndHour: 24, sendOnWeekends: true });
    const { leadId, organizationId } = await upsertLead({ name: "Riverside Ortho", specialty: "Orthopaedic Surgery", city: "Austin", state: "TX", phone: "512-555-0100", website: website ?? undefined, official: { name: "Huong T. Le, MD", title: "Owner", phone: "512-555-0100", credential: "MD" } });
    return { leadId, organizationId };
  }
  const emailOf = async (name: string) => (await query<any>("SELECT * FROM contacts WHERE full_name LIKE $1", [`${name}%`]))[0];

  it("learns the domain's pattern from a published address, verifies the official's guess, then drafts", async () => {
    const { leadId, organizationId } = await org();
    await addContact(organizationId, { full_name: "Jane Smith", email: "jane.smith@riverside-ortho.test", source: "research" });
    await query("UPDATE contacts SET email_source = 'published' WHERE email IS NOT NULL");
    const verified: string[] = [];
    const sv = async (e: string) => { verified.push(e); return e === "huong.le@riverside-ortho.test" ? { status: "valid" as const, reason: "ok" } : { status: "invalid" as const, reason: "no" }; };
    const run = await enqueueRun({ kind: "contacts", leadId, input: { thenOutreach: true } });
    await drain(makeDeps({ smtpVerify: sv as any }));
    expect((await getRun(run.id))!.status).toBe("succeeded");
    const h = await emailOf("Huong");
    expect(h).toMatchObject({ email: "huong.le@riverside-ortho.test", email_source: "pattern", email_status: "verified", email_confidence: 95 });
    expect(verified[0]).toBe("huong.le@riverside-ortho.test"); // the learned pattern (first.last) was tried first
    expect((await query<any>("SELECT * FROM email_patterns WHERE domain = 'riverside-ortho.test'"))[0]).toMatchObject({ pattern: "first.last", hits: 2 });
    expect(await query("SELECT 1 FROM agent_runs WHERE kind = 'outreach'")).toHaveLength(1);
    expect((await queryOne<any>("SELECT to_email FROM messages"))!.to_email).toBe("huong.le@riverside-ortho.test"); // a verified decision-maker beats a non-decision-maker's published address
  });

  it("tries the next candidate when the first does not exist", async () => {
    const { leadId } = await org();
    const tried: string[] = [];
    await enqueueRun({ kind: "contacts", leadId });
    await drain(makeDeps({ smtpVerify: (async (e: string) => { tried.push(e); return e === "hle@riverside-ortho.test" ? { status: "valid", reason: "ok" } : { status: "invalid", reason: "no" }; }) as any }));
    expect(tried.slice(0, 2)).toEqual(["huong.le@riverside-ortho.test", "hle@riverside-ortho.test"]);
    expect((await emailOf("Huong")).email).toBe("hle@riverside-ortho.test");
    expect((await query<any>("SELECT pattern FROM email_patterns"))[0].pattern).toBe("flast");
  });

  it("catch-all / unknown / unverified guesses are saved but NOT used for outreach unless the operator allows guesses", async () => {
    for (const mode of ["catch", "unknown"] as const) {
      await resetDb();
      const { leadId, organizationId } = await org();
      await enqueueRun({ kind: "contacts", leadId, input: { thenOutreach: true } });
      await drain(makeDeps({ smtpVerify: verifierWith([], mode) as any }));
      const h = await emailOf("Huong");
      expect(h.email).toBe("huong.le@riverside-ortho.test");
      expect(h.email_status).toBe(mode === "catch" ? "risky" : "unverified");
      expect(h.email_confidence).toBe(mode === "catch" ? 35 : 25);
      expect(await pickContact(organizationId)).toBeNull();
      expect(await query("SELECT 1 FROM agent_runs WHERE kind = 'outreach'")).toHaveLength(0);
      await saveSettings({ allowGuessedEmails: true });
      expect((await pickContact(organizationId, true))!.email).toBe("huong.le@riverside-ortho.test");
    }
  });

  it("no verifier configured: best guess kept unverified; nothing guessed when every candidate is invalid", async () => {
    const a = await org();
    await enqueueRun({ kind: "contacts", leadId: a.leadId });
    await drain(makeDeps());
    expect(await emailOf("Huong")).toMatchObject({ email_status: "unverified", email_source: "pattern", email_confidence: 25 });
    await resetDb();
    const b = await org();
    const r = await enqueueRun({ kind: "contacts", leadId: b.leadId });
    await drain(makeDeps({ smtpVerify: verifierWith([]) as any }));
    expect((await emailOf("Huong")).email).toBeNull();
    expect((await query("SELECT message FROM agent_events WHERE run_id = $1 AND message LIKE '%none of the likely addresses%'", [r.id]))).toHaveLength(1);
  });

  it("finds the website itself, stores its confidence, and gives up cleanly when it cannot", async () => {
    const { leadId } = await org(null);
    const web = { fetchPage: async (u: string) => new URL(u).origin === "https://riversideortho.com" ? { url: u, status: 200, title: "Riverside Ortho", text: "Riverside Ortho, Austin TX, 512-555-0100. Patients welcome." , links: [], emails: [] } : null, search: async () => [] } as any;
    await enqueueRun({ kind: "contacts", leadId });
    await drain(makeDeps({ web, domainGuess: true, smtpVerify: verifierWith(["huong.le@riversideortho.com"]) as any }));
    const o = (await queryOne<any>("SELECT website, website_confidence FROM organizations"))!;
    expect(o.website).toBe("https://riversideortho.com");
    expect(o.website_confidence).toBeGreaterThanOrEqual(60);
    expect((await emailOf("Huong")).email).toBe("huong.le@riversideortho.com");

    await resetDb();
    const b = await org(null);
    const r = await enqueueRun({ kind: "contacts", leadId: b.leadId });
    await drain(makeDeps({ web: { fetchPage: async () => null, search: async () => [] } as any, domainGuess: true }));
    expect((await getRun(r.id))!.output).toMatchObject({ skipped: "no_website", usableContact: false });
  });

  it("skips unusable domains and domains without a mail server", async () => {
    const a = await org("http://127.0.0.1:3000");
    const r1 = await enqueueRun({ kind: "contacts", leadId: a.leadId });
    await drain(makeDeps({ smtpVerify: verifierWith([]) as any }));
    expect((await getRun(r1.id))!.output).toMatchObject({ skipped: "unusable_domain" });
    await resetDb();
    const b = await org();
    const r2 = await enqueueRun({ kind: "contacts", leadId: b.leadId });
    await drain(makeDeps({ mxCheck: async () => false, smtpVerify: verifierWith([]) as any }));
    expect((await getRun(r2.id))!.output).toMatchObject({ skipped: "no_mail_server" });
  });

  it("only looks up people who have no usable address, decision-makers first, max 3", async () => {
    const { leadId, organizationId } = await org();
    for (const n of ["Ann Lee", "Bob Ray", "Cy Fox"]) await addContact(organizationId, { full_name: n, source: "manual" });
    await addContact(organizationId, { full_name: "Dee Gray", email: "dee@riverside-ortho.test" });
    const asked = new Set<string>();
    const run = await enqueueRun({ kind: "contacts", leadId });
    await drain(makeDeps({ smtpVerify: (async (e: string) => { asked.add(e.split("@")[0].split(/[._]/)[0]); return { status: "invalid", reason: "x" }; }) as any }));
    expect(asked.has("huong")).toBe(true); // the registry official is a decision-maker: first in line
    expect(asked.has("dee")).toBe(false);  // already has an address
    expect((await getRun(run.id))!.output).toMatchObject({ targets: 3 }); // 4 people lack an address; only 3 are looked up
  });

  it("research queues the contact finder when no decision-maker address was published", async () => {
    const site = await startSite({ "/": "<html><body><h1>Riverside Ortho</h1>Austin TX</body></html>" });
    try {
      const { leadId } = await upsertLead({ name: "Riverside Ortho", city: "Austin", state: "TX", website: site.url, official: { name: "Huong Le", title: "Owner", phone: null, credential: null } });
      const r = await enqueueRun({ kind: "research", leadId, input: { thenOutreach: true } });
      await drain(makeDeps());
      const child = (await query<any>("SELECT status, output FROM agent_runs WHERE kind = 'contacts' AND parent_id = $1", [r.id]))[0];
      expect(child.status).toBe("succeeded");
      expect(child.output).toMatchObject({ skipped: "unusable_domain" }); // 127.0.0.1 test site
      expect((await getLead(leadId))!.stage).toBe("researched");
    } finally { await site.close(); }
    process.env.AGENT_CONTACTS = "off";
    try {
      await resetDb();
      const s2 = await startSite({ "/": "<html><body><h1>Riverside Ortho</h1></body></html>" });
      const { leadId } = await upsertLead({ name: "Riverside Ortho", city: "Austin", state: "TX", website: s2.url });
      await enqueueRun({ kind: "research", leadId });
      await drain(makeDeps());
      expect(await query("SELECT 1 FROM agent_runs WHERE kind = 'contacts'")).toHaveLength(0);
      await s2.close();
    } finally { delete process.env.AGENT_CONTACTS; }
  });

  it("pickContact ranking: published decision-maker > published > verified guess > unverified guess (never)", async () => {
    const { organizationId } = await org();
    await query("UPDATE contacts SET email = 'huong.le@riverside-ortho.test', email_source = 'pattern', email_status = 'verified', email_confidence = 90");
    await addContact(organizationId, { full_name: "Jane Smith", email: "jane@riverside-ortho.test", is_decision_maker: false });
    await addContact(organizationId, { email: "info@riverside-ortho.test" });
    expect((await pickContact(organizationId))!.email).toBe("huong.le@riverside-ortho.test"); // decision-maker, verified guess beats a non-DM published person
    await query("UPDATE contacts SET email_status = 'unverified' WHERE email_source = 'pattern'");
    expect((await pickContact(organizationId))!.email).toBe("jane@riverside-ortho.test");
    await query("UPDATE contacts SET email_status = 'invalid' WHERE email = 'jane@riverside-ortho.test'");
    expect((await pickContact(organizationId))!.email).toBe("info@riverside-ortho.test");
  });
});
