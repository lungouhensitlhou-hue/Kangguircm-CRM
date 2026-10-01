import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "../src/db";
import { enqueueRun, getRun, listEvents } from "../src/queue";
import { executeRun, processOne } from "../src/agents/worker";
import { claimRun } from "../src/queue";
import { getContacts, getLead, listLeads, upsertLead, addContact, setStage } from "../src/leads";
import { approveMessage, editDraft, recordInbound, rejectMessage, unsubscribeByToken } from "../src/messages";
import { isSuppressed, suppress } from "../src/compliance";
import { saveSettings } from "../src/settings";
import { postChatMessage } from "../src/agents/chat";
import { PAGES, FakeNpi, ScriptedLLM, makeDeps, readySettings, resetDb, setupDb, startSite, teardownDb } from "./helpers";
import type { Message } from "../src/types";

beforeAll(setupDb);
beforeEach(resetDb);
afterAll(teardownDb);

/** Drain the queue with the given deps, returning how many runs ran. */
async function drain(deps: any, max = 50) {
  let n = 0;
  while (n < max && (await processOne("test", deps))) n++;
  return n;
}
const NOON_ET = () => new Date("2026-09-30T16:00:00Z"); // Wednesday 12:00 ET

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => { site = await startSite(PAGES); });
afterAll(async () => { await site.close(); });

const NPI_DATA = [
  { name: "Riverside Orthopedics", npi: "1001", specialty: "Orthopedic Surgery", city: "Austin", state: "TX", entity_type: "organization" },
  { name: "Lakeside Cardiology", npi: "1002", specialty: "Cardiology", city: "Dallas", state: "TX", entity_type: "organization" },
  { name: "Sunrise Urgent Care", npi: "1003", specialty: "Urgent Care", city: "Miami", state: "FL", entity_type: "organization" },
];

describe("discover agent", () => {
  it("imports from the registry, dedupes on re-run, and fans out research", async () => {
    const npi = new FakeNpi(NPI_DATA);
    const deps = makeDeps({ npi });
    const r1 = await enqueueRun({ kind: "discover", input: { states: ["TX"], taxonomy: "Ortho", limit: 3, autoResearch: true, researchTop: 2 } });
    await processOne("t", deps);
    let run = (await getRun(r1.id))!;
    expect(run.status).toBe("succeeded");
    expect(run.output).toMatchObject({ fetched: 3, created: 3, existing: 0, researchQueued: 2 });
    expect(npi.calls[0]).toMatchObject({ state: "TX", taxonomy: "Ortho", limit: 3 });
    expect((await query("SELECT count(*)::int n FROM agent_runs WHERE kind='research'"))[0].n).toBe(2);
    const r2 = await enqueueRun({ kind: "discover", input: { states: ["TX"], taxonomy: "Ortho", limit: 3 } });
    await drain(deps);
    run = (await getRun(r2.id))!;
    expect(run.output).toMatchObject({ created: 0, existing: 3 });
  });

  it("paginates across pages of 200 and stops on short page", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ name: `Clinic ${i}`, npi: String(5000 + i), city: "X", state: "TX" }));
    const npi = new FakeNpi(many);
    const r = await enqueueRun({ kind: "discover", input: { states: ["TX"], taxonomy: "x", limit: 250 } });
    await processOne("t", makeDeps({ npi }));
    expect((await getRun(r.id))!.output).toMatchObject({ fetched: 250, created: 250 });
    expect(npi.calls.map((c) => [c.skip, c.limit])).toEqual([[0, 200], [200, 50]]);
  });

  it("rejects invalid input without retrying", async () => {
    const r = await enqueueRun({ kind: "discover", input: { states: ["Texas"], taxonomy: "x" } });
    const r2 = await enqueueRun({ kind: "discover", input: { states: ["TX"] } });
    await drain(makeDeps());
    for (const id of [r.id, r2.id]) {
      const run = (await getRun(id))!;
      expect(run.status).toBe("failed");
      expect(run.attempts).toBe(1);
    }
    expect((await getRun(r2.id))!.error).toMatch(/state alone/);
  });
});

describe("research agent (no LLM: heuristics)", () => {
  it("reads the site, honors robots.txt, extracts contacts, scores and advances the stage", async () => {
    const { leadId } = await upsertLead({ name: "Riverside Orthopedics", specialty: "Orthopedic Surgery", city: "Austin", state: "TX", website: site.url });
    const r = await enqueueRun({ kind: "research", leadId });
    await processOne("t", makeDeps());
    const run = (await getRun(r.id))!;
    expect(run.status, run.error ?? "").toBe("succeeded");
    const lead = (await getLead(leadId))!;
    expect(lead.stage).toBe("researched");
    expect(lead.score).toBeGreaterThan(50);
    expect(lead.org.ehr).toBe("athenahealth");
    const contacts = await getContacts(lead.organization_id);
    const emails = contacts.map((c) => c.email).filter(Boolean);
    expect(emails).toContain("info@riverside-ortho.test");
    expect(emails).toContain("jane.smith@riverside-ortho.test");
    expect(emails).not.toContain("secret@riverside-ortho.test"); // /private is disallowed by robots.txt
    const named = contacts.filter((c) => c.full_name);
    expect(named.map((c) => c.full_name)).toEqual(expect.arrayContaining(["Jane Smith", "Robert Alvarez"]));
    const profile = await queryOne<any>("SELECT * FROM research_profiles WHERE lead_id = $1", [leadId]);
    expect(profile.method).toBe("heuristic");
    expect(profile.sources.map((s: any) => s.url)).toContain(`${site.url}/team`);
    expect(profile.pain_points.map((p: any) => p.point)).toContain("Hiring billing / coding staff");
  });

  it("survives an unreachable site and a missing website", async () => {
    const a = await upsertLead({ name: "Ghost Clinic", city: "X", state: "TX", website: "http://127.0.0.1:1" });
    const b = await upsertLead({ name: "No Web Clinic", city: "Y", state: "TX" });
    await enqueueRun({ kind: "research", leadId: a.leadId });
    await enqueueRun({ kind: "research", leadId: b.leadId });
    await drain(makeDeps());
    for (const l of [a, b]) {
      const lead = (await getLead(l.leadId))!;
      expect(lead.stage).toBe("researched");
      expect(lead.score).toBeLessThan(30);
    }
    expect((await query("SELECT count(*)::int n FROM agent_runs WHERE status='failed'"))[0].n).toBe(0);
  });

  it("uses the LLM, grounds its output, and tracks tokens + cost", async () => {
    const { leadId } = await upsertLead({ name: "Riverside Orthopedics", specialty: "Orthopedic Surgery", city: "Austin", state: "TX", website: site.url });
    const llm = new ScriptedLLM({
      json: () => ({
        summary: "Three-location orthopedic group on athenahealth.", ehr: "athenahealth", size_estimate: "~3 providers, 3 locations", specialties: ["Orthopedics"], confidence: 0.82,
        pain_points: [{ point: "Hiring billing staff", evidence: "Now hiring: medical biller" }, { point: "Fabricated", evidence: "they lost $5M to denials last year" }],
        decision_makers: [{ name: "Jane Smith", title: "Practice Manager", email: "jane.smith@riverside-ortho.test" }, { name: "Nobody Real", title: "CEO", email: "ceo@nowhere.test" }],
      }),
    });
    const r = await enqueueRun({ kind: "research", leadId });
    await processOne("t", makeDeps({ llm }));
    const profile = await queryOne<any>("SELECT * FROM research_profiles WHERE lead_id = $1", [leadId]);
    expect(profile.method).toBe("llm");
    expect(profile.decision_makers.map((d: any) => d.name)).toEqual(["Jane Smith"]);
    expect(profile.pain_points).toHaveLength(1);
    expect(llm.jsonCalls[0].prompt).toContain("<untrusted_website_content>");
    const contacts = await getContacts((await getLead(leadId))!.organization_id);
    const jane = contacts.find((c) => c.email === "jane.smith@riverside-ortho.test")!;
    expect(jane).toMatchObject({ full_name: "Jane Smith", is_decision_maker: true });
    expect(contacts.find((c) => c.email === "ceo@nowhere.test")).toBeUndefined();
    const run = (await getRun(r.id))!;
    expect(run.tokens_in).toBe(1000);
    expect(Number(run.cost_usd)).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6, 6);
    expect((await getLead(leadId))!.score).toBeGreaterThan(70);
  });

  it("falls back to heuristics when the LLM errors", async () => {
    const { leadId } = await upsertLead({ name: "Riverside Orthopedics", city: "Austin", state: "TX", website: site.url });
    const llm = new ScriptedLLM({ json: () => { throw new Error("api down"); } });
    (llm as any).json = async () => { throw new Error("api down"); };
    await enqueueRun({ kind: "research", leadId });
    await processOne("t", makeDeps({ llm }));
    expect((await queryOne<any>("SELECT method FROM research_profiles"))!.method).toBe("heuristic");
    expect((await getLead(leadId))!.stage).toBe("researched");
  });
});

describe("outreach → approval → send pipeline", () => {
  async function researchedLead() {
    const { leadId, organizationId } = await upsertLead({ name: "Riverside Orthopedics", specialty: "Orthopedic Surgery", city: "Austin", state: "TX", website: site.url });
    await enqueueRun({ kind: "research", leadId, input: { thenOutreach: true } });
    await drain(makeDeps({ now: NOON_ET }));
    return { leadId, organizationId };
  }

  it("drafts to the best contact with a compliant footer; nothing sends until approved", async () => {
    await readySettings();
    const { leadId } = await researchedLead();
    const drafts = await query<Message>("SELECT * FROM messages WHERE lead_id = $1", [leadId]);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.status).toBe("draft");
    expect(d.to_email).toBe("jane.smith@riverside-ortho.test");
    expect(d.body).toMatch(/^Hi Jane,/);
    expect(d.body).toContain("100 Main St, Suite 5, Austin, TX 78701");
    expect(d.body).toContain(`http://app.test/unsubscribe/${d.unsub_token}`);
    expect((await getLead(leadId))!.stage).toBe("outreach_drafted");
    const deps = makeDeps();
    await drain(deps);
    expect(deps.mailer.outbox).toHaveLength(0);
  });

  it("approve → send (dry run) → contacted, with List-Unsubscribe headers and follow-up scheduled", async () => {
    await readySettings();
    const { leadId } = await researchedLead();
    const d = (await queryOne<Message>("SELECT * FROM messages"))!;
    const edited = await editDraft(d.id, { subject: "Quick question", body: "Hi Jane,\n\nEdited by a human that is definitely long enough to send.\n\nBest,\nSam\n\n--\nfake footer" }, "founder");
    expect(edited.body).toContain("Edited by a human");
    expect(edited.body).toContain("/unsubscribe/");
    expect(edited.body).not.toContain("fake footer");
    await approveMessage(d.id, "founder");
    const deps = makeDeps({ now: NOON_ET });
    await drain(deps);
    expect(deps.mailer.outbox).toHaveLength(1);
    const sent = deps.mailer.outbox[0];
    expect(sent.to).toBe("jane.smith@riverside-ortho.test");
    expect(sent.from).toBe("Sam Rivers <sam@kangguircm.test>");
    expect(sent.headers!["List-Unsubscribe"]).toBe(`<http://app.test/api/unsubscribe/${d.unsub_token}>`);
    expect(sent.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const lead = (await getLead(leadId))!;
    expect(lead.stage).toBe("contacted");
    expect(lead.next_action_at).not.toBeNull();
    expect((await queryOne<Message>("SELECT * FROM messages"))!.status).toBe("sent");
    // sending again is a no-op
    await enqueueRun({ kind: "send", input: { messageId: d.id }, idempotencyKey: "again" });
    await drain(deps);
    expect(deps.mailer.outbox).toHaveLength(1);
  });

  it("refuses to approve without a physical address / sender email (CAN-SPAM)", async () => {
    await saveSettings({ physicalAddress: "", senderEmail: "" });
    const { leadId } = await researchedLead();
    const d = (await queryOne<Message>("SELECT * FROM messages WHERE lead_id = $1", [leadId]))!;
    expect(d.body).toContain("[Set your physical mailing address");
    await expect(approveMessage(d.id, "founder")).rejects.toThrow(/physical mailing address/);
  });

  it("defers outside the send window and when the daily cap is hit", async () => {
    await readySettings({ dailySendCap: 1 });
    const { leadId } = await researchedLead();
    const d = (await queryOne<Message>("SELECT * FROM messages"))!;
    await approveMessage(d.id, "founder");
    const night = () => new Date("2026-09-30T03:00:00Z");
    const deps = makeDeps({ now: night });
    await drain(deps);
    expect(deps.mailer.outbox).toHaveLength(0);
    const run = (await queryOne<any>("SELECT * FROM agent_runs WHERE kind='send'"))!;
    expect(run.status).toBe("queued");
    expect(new Date(run.run_at).getTime()).toBeGreaterThan(night().getTime()); // rescheduled relative to the injected clock
    expect(run.attempts).toBe(0);
    // cap: pretend one message was already sent in the last 24h
    await query("UPDATE agent_runs SET run_at = now() WHERE id = $1", [run.id]);
    await query("INSERT INTO messages (lead_id, direction, to_email, status, sent_at, subject, body) VALUES ($1,'outbound','x@y.com','sent', now(), 's','b')", [leadId]);
    const deps2 = makeDeps({ now: NOON_ET });
    await drain(deps2);
    expect(deps2.mailer.outbox).toHaveLength(0);
    expect((await queryOne<any>("SELECT status FROM agent_runs WHERE kind='send'"))!.status).toBe("queued");
  });

  it("never sends to a suppressed address, even if already approved", async () => {
    await readySettings();
    await researchedLead();
    const d = (await queryOne<Message>("SELECT * FROM messages"))!;
    await approveMessage(d.id, "founder");
    await suppress("Jane.Smith@riverside-ortho.test");
    const deps = makeDeps({ now: NOON_ET });
    await drain(deps);
    expect(deps.mailer.outbox).toHaveLength(0);
    expect((await queryOne<Message>("SELECT * FROM messages"))!.status).toBe("cancelled");
  });

  it("suppressed contacts are skipped when choosing a recipient; whole domains can be blocked", async () => {
    await readySettings();
    await suppress("jane.smith@riverside-ortho.test");
    await suppress("@riverside-ortho.test");
    expect(await isSuppressed("anyone@riverside-ortho.test")).toBe(true);
    const { leadId } = await researchedLead();
    expect(await query("SELECT 1 FROM messages WHERE lead_id = $1", [leadId])).toHaveLength(0);
    const ev = await query("SELECT message FROM agent_events WHERE message LIKE 'No reachable%'");
    expect(ev).toHaveLength(1);
  });

  it("rejecting a draft cancels it; only drafts can be approved", async () => {
    await readySettings();
    await researchedLead();
    const d = (await queryOne<Message>("SELECT * FROM messages"))!;
    await rejectMessage(d.id, "founder");
    await expect(approveMessage(d.id, "founder")).rejects.toThrow(/Only drafts/);
    await expect(editDraft(d.id, { subject: "x" }, "founder")).rejects.toThrow(/Only drafts/);
  });

  it("LLM drafts are used when valid and replaced by the template when they violate rules", async () => {
    await readySettings();
    const good = "Hi Jane, I noticed Riverside Orthopedics is hiring a medical biller. We help orthopedic groups cut claim denials and speed up payments so your team can focus on patients. Would a short call next week make sense? Best, Sam";
    let first = true;
    const llm = new ScriptedLLM({ json: (p) => (p.includes("Verified facts") ? (first ? ((first = false), { subject: "Billing help for Riverside", body: good }) : { subject: "Act now!", body: "We GUARANTEE 100% results [Name] http://x.com" }) : {
      summary: "s", ehr: null, size_estimate: null, specialties: [], confidence: 0.5, pain_points: [], decision_makers: [{ name: "Jane Smith", title: "Practice Manager", email: "jane.smith@riverside-ortho.test" }] }) });
    const a = await upsertLead({ name: "Riverside Orthopedics", city: "Austin", state: "TX", website: site.url });
    await enqueueRun({ kind: "research", leadId: a.leadId, input: { thenOutreach: true } });
    await drain(makeDeps({ llm }));
    const m1 = (await queryOne<Message>("SELECT * FROM messages"))!;
    expect(m1.subject).toBe("Billing help for Riverside");
    expect(m1.body).toContain("hiring a medical biller");
    // second lead: the LLM returns a bad draft, template must be used
    await query("DELETE FROM messages");
    await query("UPDATE leads SET stage = 'researched'");
    await enqueueRun({ kind: "outreach", leadId: a.leadId, input: { step: 1 }, idempotencyKey: "again" });
    await drain(makeDeps({ llm }));
    const m2 = (await queryOne<Message>("SELECT * FROM messages"))!;
    expect(m2.subject).toBe("Billing support for Riverside Orthopedics");
    expect(m2.body).not.toMatch(/guarantee|\[Name\]|http:\/\/x\.com/i);
    const ev = await query("SELECT message FROM agent_events WHERE message LIKE 'LLM draft rejected%'");
    expect(ev).toHaveLength(1);
  });

  it("autoApprove queues the send immediately", async () => {
    await readySettings({ autoApprove: true });
    const { leadId } = await upsertLead({ name: "Riverside Orthopedics", specialty: "Orthopedic Surgery", city: "Austin", state: "TX", website: site.url });
    await enqueueRun({ kind: "research", leadId, input: { thenOutreach: true } });
    const deps = makeDeps({ now: NOON_ET });
    await drain(deps);
    expect(deps.mailer.outbox).toHaveLength(1);
    expect((await queryOne<Message>("SELECT * FROM messages"))).toMatchObject({ status: "sent", approved_by: "auto" });
  });

  it("stops emailing once a lead replies; opt-out replies suppress", async () => {
    await readySettings();
    const { leadId } = await researchedLead();
    const d = (await queryOne<Message>("SELECT * FROM messages"))!;
    await approveMessage(d.id, "founder");
    const deps = makeDeps({ now: NOON_ET });
    await drain(deps);
    // queue an unsent follow-up, then a reply arrives
    await query("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status) VALUES ($1,'outbound',2,'jane.smith@riverside-ortho.test','f','b','draft')", [leadId]);
    const r = await recordInbound({ from: "Jane Smith <Jane.Smith@riverside-ortho.test>", subject: "Re: hi", body: "Interesting. Can we talk Thursday?" });
    expect(r).toMatchObject({ matched: true, suppressed: false, leadId });
    expect((await getLead(leadId))!.stage).toBe("replied");
    expect((await query("SELECT 1 FROM messages WHERE status='cancelled' AND lead_id=$1", [leadId]))).toHaveLength(1);
    // no further outreach
    const o = await enqueueRun({ kind: "outreach", leadId, input: { step: 2 } });
    await drain(deps);
    expect((await getRun(o.id))!.output).toMatchObject({ skipped: "replied" });
    const r2 = await recordInbound({ from: "jane.smith@riverside-ortho.test", body: "Please remove me from your list." });
    expect(r2.suppressed).toBe(true);
    expect(await isSuppressed("jane.smith@riverside-ortho.test")).toBe(true);
    expect((await getLead(leadId))!.stage).toBe("disqualified");
    expect(await recordInbound({ from: "stranger@unknown.test", body: "hi" })).toMatchObject({ matched: false });
  });

  it("public unsubscribe token suppresses the recipient and cancels pending drafts", async () => {
    await readySettings();
    await researchedLead();
    const d = (await queryOne<Message>("SELECT * FROM messages"))!;
    expect(await unsubscribeByToken("bogus")).toEqual({ ok: false });
    expect(await unsubscribeByToken(d.unsub_token!)).toEqual({ ok: true, email: d.to_email });
    expect(await unsubscribeByToken(d.unsub_token!)).toMatchObject({ ok: true });
    expect(await isSuppressed(d.to_email!)).toBe(true);
    expect((await queryOne<Message>("SELECT * FROM messages"))!.status).toBe("cancelled");
  });
});

describe("sweep (follow-ups & housekeeping)", () => {
  it("drafts follow-ups only when due, once, and stops after the last step", async () => {
    await readySettings({ followupDays: [3, 7] });
    const { leadId, organizationId } = await upsertLead({ name: "Follow Clinic", city: "A", state: "TX" });
    await addContact(organizationId, { full_name: "Pat Doe", email: "pat@follow.test", is_decision_maker: true });
    await setStage(leadId, "contacted");
    await query("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, sent_at) VALUES ($1,'outbound',1,'pat@follow.test','Hello','b','sent', now() - interval '1 day')", [leadId]);
    const deps = makeDeps({ now: () => new Date() });
    await enqueueRun({ kind: "sweep", idempotencyKey: "s1" });
    await drain(deps);
    expect(await query("SELECT 1 FROM messages WHERE step = 2")).toHaveLength(0);
    await query("UPDATE messages SET sent_at = now() - interval '4 days'");
    await enqueueRun({ kind: "sweep", idempotencyKey: "s2" });
    await drain(deps);
    const f = await query<Message>("SELECT * FROM messages WHERE step = 2");
    expect(f).toHaveLength(1);
    expect(f[0].status).toBe("draft");
    expect(f[0].subject.startsWith("Re: ")).toBe(true);
    await enqueueRun({ kind: "sweep", idempotencyKey: "s3" });
    await drain(deps);
    expect(await query("SELECT 1 FROM messages WHERE step = 2")).toHaveLength(1);
    // after step 3 is sent nothing more is drafted
    await query("UPDATE messages SET status='sent', sent_at = now() - interval '8 days' WHERE step = 2");
    await query("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, sent_at) VALUES ($1,'outbound',3,'pat@follow.test','Re: Hello','b','sent', now() - interval '30 days')", [leadId]);
    await enqueueRun({ kind: "sweep", idempotencyKey: "s4" });
    await drain(deps);
    expect(await query("SELECT 1 FROM messages WHERE step = 4")).toHaveLength(0);
  });

  it("re-queues approved messages that lost their send job", async () => {
    await readySettings();
    const { leadId } = await upsertLead({ name: "Lost Job Clinic" });
    await query("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, unsub_token) VALUES ($1,'outbound',1,'a@b.test','s','b','approved','tok')", [leadId]);
    const deps = makeDeps({ now: NOON_ET });
    await enqueueRun({ kind: "sweep", idempotencyKey: "s1" });
    await drain(deps);
    expect(deps.mailer.outbox).toHaveLength(1);
  });
});

describe("chat agent", () => {
  it("works without an LLM via the rule-based interpreter", async () => {
    await upsertLead({ name: "Riverside Orthopedics", city: "Austin", state: "TX", specialty: "Orthopedics" });
    const deps = makeDeps({ npi: new FakeNpi([]) });
    const ask = async (t: string) => {
      const { runId } = await postChatMessage("t1", t);
      await drain(deps);
      expect((await getRun(runId))!.status).toBe("succeeded");
      return (await queryOne<any>("SELECT content FROM chat_messages WHERE run_id = $1", [runId]))!.content as string;
    };
    expect(await ask("stats")).toMatch(/1 leads/);
    expect(await ask("find riverside in TX")).toContain("Riverside Orthopedics");
    expect(await ask("research riverside")).toMatch(/Queued research for Riverside/);
    expect(await query("SELECT 1 FROM agent_runs WHERE kind='research'")).toHaveLength(1);
    expect(await ask("discover orthopedic in TX,FL limit 20")).toMatch(/Started discovery/);
    expect(await ask("contacts riverside")).toMatch(/Started the contact finder for Riverside Orthopedics/);
    expect(await query("SELECT 1 FROM agent_runs WHERE kind='contacts' AND created_by='chat'")).toHaveLength(1);
    expect(await ask("find contacts for nobody-here")).toMatch(/couldn't find/);
    expect(await ask("approvals")).toMatch(/No drafts/);
    expect(await ask("help")).toMatch(/No AI key/);
    expect(await ask("dance")).toMatch(/didn't understand/);
  });

  it("drives CRM tools through the LLM tool loop, and cannot send email", async () => {
    const { leadId } = await upsertLead({ name: "Riverside Orthopedics", city: "Austin", state: "TX" });
    const seen: string[] = [];
    const llm = new ScriptedLLM({
      converse: async (o) => {
        expect(o.tools.map((t) => t.name)).not.toContain("send_email");
        expect(o.system).toContain("can NOT send emails");
        expect(o.messages.at(-1)!.content).toBe("Research Riverside and move it to researching");
        const found = JSON.parse(await o.onTool("search_leads", { q: "riverside" }));
        seen.push("search");
        await o.onTool("research_lead", { lead_id: found.leads[0].id });
        await o.onTool("move_stage", { lead_id: found.leads[0].id, stage: "researching" });
        await o.onTool("add_note", { lead_id: found.leads[0].id, note: "founder likes this one" });
        await expect(o.onTool("move_stage", { lead_id: found.leads[0].id, stage: "bogus" })).rejects.toThrow();
        await expect(o.onTool("nope", {})).rejects.toThrow(/Unknown tool/);
        return { text: "Started research and moved it.", usage: { tokensIn: 10, tokensOut: 5 }, steps: 2 };
      },
    });
    const { runId } = await postChatMessage("t2", "Research Riverside and move it to researching");
    await drain(makeDeps({ llm }));
    expect((await getRun(runId))!.status).toBe("succeeded");
    expect(await query("SELECT 1 FROM audit_log WHERE actor = 'chat' AND data->>'to' = 'researching'")).toHaveLength(1);
    expect((await getLead(leadId))!.notes).toContain("founder likes this one");
    expect(await query("SELECT 1 FROM agent_runs WHERE kind='research' AND lead_id=$1", [leadId])).toHaveLength(1);
    expect((await queryOne<any>("SELECT content FROM chat_messages WHERE run_id=$1", [runId]))!.content).toBe("Started research and moved it.");
    expect(seen).toEqual(["search"]);
  });

  it("reports failures to the user instead of hanging", async () => {
    const llm = new ScriptedLLM({ converse: async () => { throw new Error("rate limited"); } });
    const { runId } = await postChatMessage("t3", "hello");
    await drain(makeDeps({ llm }));
    expect((await queryOne<any>("SELECT content FROM chat_messages WHERE run_id=$1", [runId]))!.content).toContain("rate limited");
  });
});

describe("worker isolation", () => {
  it("a failing run does not stop others", async () => {
    await enqueueRun({ kind: "smoke", input: { fail: true }, maxAttempts: 1 });
    const ok = await enqueueRun({ kind: "smoke", input: { steps: 1, delayMs: 1 } });
    await drain(makeDeps());
    expect((await getRun(ok.id))!.status).toBe("succeeded");
  });
});
