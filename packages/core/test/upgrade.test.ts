import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "../src/db";
import { enqueueRun, getRun } from "../src/queue";
import { processOne } from "../src/agents/worker";
import { addContact, getContacts, getLead, setStage, upsertLead } from "../src/leads";
import { recordInbound } from "../src/messages";
import { classifyReplyHeuristic, isAutoReply } from "../src/agents/reply";
import { mergeExtractions } from "../src/agents/deep-research";
import { winningExamples } from "../src/agents/outreach";
import { alwaysDeliverable, dnsMxCheck } from "../src/providers/mx";
import { depsFromEnv } from "../src/agents/deps";
import { PAGES, ScriptedLLM, makeDeps, readySettings, resetDb, setupDb, startSite, teardownDb } from "./helpers";

beforeAll(setupDb);
beforeEach(resetDb);
afterAll(teardownDb);

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => { site = await startSite(PAGES); });
afterAll(async () => { await site.close(); });
async function drain(deps: any) { let n = 0; while (n < 60 && (await processOne("t", deps))) n++; return n; }

describe("reply classification (rules)", () => {
  const c = (subject: string, body: string) => classifyReplyHeuristic(subject, body, "jane@x.test");
  it("recognizes each reply type", () => {
    expect(c("Re: hi", "Yes I'm interested, let's schedule a call next week").label).toBe("interested");
    expect(c("Re: hi", "Can you send more information about pricing?").label).toBe("interested");
    expect(c("Re: hi", "Not interested, thanks").label).toBe("not_interested");
    expect(c("Re: hi", "We handle billing in-house so we're all set").label).toBe("not_interested");
    expect(c("Re: hi", "Not right now, please reach out again next quarter").label).toBe("not_now");
    expect(c("Re: hi", "You should talk to Bob Lee, bob@x2.test, he runs billing").label).toBe("referral");
    expect(c("Re: hi", "Which EHRs do you integrate with?").label).toBe("question");
    expect(c("Automatic reply: Out of office", "I am out of the office until Monday").label).toBe("out_of_office");
    expect(c("Re: hi", "ok").label).toBe("other");
    expect(c("Re: hi", "Thanks, sounds good.\n\nOn Tue, Sam wrote:\n> not interested at all in the old thread").label).toBe("interested"); // quoted history ignored
    const r = c("Re: hi", "Please contact bob@x2.test instead");
    expect(r.referral?.email).toBe("bob@x2.test");
  });
  it("detects auto replies", () => {
    expect(isAutoReply("Out of Office: Re: hi", "")).toBe(true);
    expect(isAutoReply("Re: hi", "Thanks, I'm on maternity leave until June")).toBe(true);
    expect(isAutoReply("Re: hi", "Happy to chat Thursday")).toBe(false);
  });
});

describe("inbound handling + reply agent", () => {
  async function contactedLead(email = "jane@practice.test") {
    await readySettings();
    const { leadId, organizationId } = await upsertLead({ name: "Reply Clinic", specialty: "Orthopedic Surgery", city: "Austin", state: "TX", website: "https://practice.test" });
    await addContact(organizationId, { full_name: "Jane Smith", title: "Practice Manager", email, is_decision_maker: true });
    await setStage(leadId, "contacted");
    await query("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, sent_at, unsub_token) VALUES ($1,'outbound',1,$2,'Billing help','Hi Jane','sent', now() - interval '1 day','t1')", [leadId, email]);
    await query("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, unsub_token) VALUES ($1,'outbound',2,$2,'Re: Billing help','follow up','draft','t2')", [leadId, email]);
    return leadId;
  }

  it("out-of-office replies are stored but neither stop the sequence nor count as a reply", async () => {
    const leadId = await contactedLead();
    const r = await recordInbound({ from: "jane@practice.test", subject: "Automatic reply: Out of office", body: "I am away until Monday." });
    expect(r).toMatchObject({ matched: true, auto: true });
    expect((await getLead(leadId))!.stage).toBe("contacted");
    expect(await query("SELECT 1 FROM messages WHERE status = 'draft' AND lead_id = $1", [leadId])).toHaveLength(1);
    expect(await query("SELECT 1 FROM agent_runs WHERE kind = 'reply'")).toHaveLength(0);
    expect((await queryOne<any>("SELECT classification FROM messages WHERE direction = 'inbound'"))!.classification).toBe("out_of_office");
  });

  it("interested reply → stage replied, follow-up cancelled, reply drafted for approval (never sent)", async () => {
    const leadId = await contactedLead();
    await recordInbound({ from: "Jane Smith <jane@practice.test>", subject: "Re: Billing help", body: "Sounds good, let's schedule a call." });
    expect((await getLead(leadId))!.stage).toBe("replied");
    const deps = makeDeps();
    await drain(deps);
    const inbound = (await queryOne<any>("SELECT * FROM messages WHERE direction='inbound'"))!;
    expect(inbound.classification).toBe("interested");
    expect(inbound.meta.how).toBe("rules");
    const d = (await queryOne<any>("SELECT * FROM messages WHERE direction='outbound' AND status='draft'"))!;
    expect(d.to_email).toBe("jane@practice.test");
    expect(d.subject).toBe("Re: Billing help");
    expect(d.body).toMatch(/^Hi Jane,/);
    expect(d.body).toContain("15-minute call");
    expect(d.body).toContain("/unsubscribe/");
    expect(d.step).toBe(3);
    expect(d.meta.replyTo).toBe(inbound.id);
    expect(deps.mailer.outbox).toHaveLength(0);
  });

  it("not interested → lost, no reply drafted", async () => {
    const leadId = await contactedLead();
    await recordInbound({ from: "jane@practice.test", subject: "Re: x", body: "No thanks, not interested." });
    await drain(makeDeps());
    expect((await getLead(leadId))!.stage).toBe("lost");
    expect(await query("SELECT 1 FROM messages WHERE direction='outbound' AND status='draft'")).toHaveLength(0);
  });

  it("not now → next action in ~90 days with a gracious draft", async () => {
    const leadId = await contactedLead();
    await recordInbound({ from: "jane@practice.test", subject: "Re: x", body: "Not right now, maybe reach out next quarter." });
    await drain(makeDeps());
    const lead = (await getLead(leadId))!;
    const days = (new Date(lead.next_action_at!).getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(88);
    expect(days).toBeLessThan(91);
    expect((await queryOne<any>("SELECT body FROM messages WHERE status='draft' AND direction='outbound'"))!.body).toContain("no pressure");
  });

  it("referral → new decision-maker contact added and thank-you drafted; questions need a human", async () => {
    const leadId = await contactedLead();
    await recordInbound({ from: "jane@practice.test", subject: "Re: x", body: "Please reach out to Bob Lee at bob.lee@practice.test, he handles billing." });
    await drain(makeDeps());
    const org = (await getLead(leadId))!.organization_id;
    const bob = (await getContacts(org)).find((c) => c.email === "bob.lee@practice.test")!;
    expect(bob).toMatchObject({ is_decision_maker: true, source: "referral" });
    expect(await query("SELECT 1 FROM messages WHERE status='draft' AND direction='outbound' AND body LIKE '%pointing me%'")).toHaveLength(1);

    await resetDb();
    const l2 = await contactedLead();
    await recordInbound({ from: "jane@practice.test", subject: "Re: x", body: "Which EHRs do you support?" });
    const runId = (await queryOne<any>("SELECT id FROM agent_runs WHERE kind='reply'"))!.id;
    await drain(makeDeps());
    expect((await queryOne<any>("SELECT classification FROM messages WHERE direction='inbound'"))!.classification).toBe("question");
    expect(await query("SELECT 1 FROM messages WHERE status='draft' AND direction='outbound' AND step = 3")).toHaveLength(0);
    expect((await query("SELECT message FROM agent_events WHERE run_id = $1", [runId])).some((e: any) => /needs a human/.test(e.message))).toBe(true);
    expect((await getLead(l2))!.stage).toBe("replied");
  });

  it("with an AI model: uses its analysis and reply, drops hallucinated referrals, rejects rule-breaking replies", async () => {
    const leadId = await contactedLead();
    await recordInbound({ from: "jane@practice.test", subject: "Re: x", body: "Talk to Bob Lee, bob.lee@practice.test." });
    const llm = new ScriptedLLM({ json: () => ({
      label: "referral", summary: "Points us to Bob.",
      referral: { name: "Bob Lee", email: "bob.lee@practice.test", title: "Billing Manager" },
      suggested_reply: "Thanks Jane, see https://evil.test and we guarantee results! [Name]",
    }) });
    await drain(makeDeps({ llm }));
    const inbound = (await queryOne<any>("SELECT * FROM messages WHERE direction='inbound'"))!;
    expect(inbound.meta.how).toBe("llm");
    const draft = (await queryOne<any>("SELECT * FROM messages WHERE status='draft' AND direction='outbound' AND step = 3"))!;
    expect(draft.body).not.toMatch(/evil\.test|guarantee|\[Name\]/i); // template used instead
    expect(draft.body).toContain("pointing me");

    await resetDb();
    await contactedLead();
    await recordInbound({ from: "jane@practice.test", subject: "Re: x", body: "Please talk to my colleague about it." });
    const llm2 = new ScriptedLLM({ json: () => ({ label: "referral", summary: "s", referral: { name: "Made Up", email: "madeup@nowhere.test", title: null }, suggested_reply: null }) });
    await drain(makeDeps({ llm: llm2 }));
    expect(await query("SELECT 1 FROM contacts WHERE email = 'madeup@nowhere.test'")).toHaveLength(0);
    expect((await queryOne<any>("SELECT classification FROM messages WHERE direction='inbound'"))!.classification).toBe("other");
  });

  it("falls back to rules if the model errors", async () => {
    await contactedLead();
    await recordInbound({ from: "jane@practice.test", subject: "Re: x", body: "Not interested." });
    const llm = new ScriptedLLM({ json: () => { throw new Error("overloaded"); } });
    await drain(makeDeps({ llm }));
    const inbound = (await queryOne<any>("SELECT * FROM messages WHERE direction='inbound'"))!;
    expect(inbound.classification).toBe("not_interested");
    expect(inbound.meta.how).toBe("rules");
  });
});

describe("deep research agent", () => {
  it("digs with tools when the first pass finds no reachable decision-maker, and grounds the result", async () => {
    await readySettings();
    const { leadId } = await upsertLead({ name: "Riverside Orthopedics", specialty: "Orthopedic Surgery", city: "Austin", state: "TX", website: site.url });
    let converseCalls = 0;
    const llm = new ScriptedLLM({
      json: () => ({ summary: "Ortho group.", ehr: null, size_estimate: null, specialties: [], pain_points: [], decision_makers: [], confidence: 0.3 }),
      converse: async (o) => {
        converseCalls++;
        expect(o.system).toContain("Never guess an email");
        expect(o.tools.map((t) => t.name)).toEqual(["web_search", "fetch_page", "submit_findings"]);
        const search = JSON.parse(await o.onTool("web_search", { query: "Riverside Orthopedics billing manager" }));
        expect(search.results).toEqual([]); // no search provider in tests: tool degrades gracefully
        const page = JSON.parse(await o.onTool("fetch_page", { url: `${site.url}/staff-directory` }));
        expect(page.emails_on_page).toContain("ralvarez@riverside-ortho.test");
        expect(JSON.parse(await o.onTool("fetch_page", { url: `${site.url}/private/admin` })).error).toMatch(/Could not fetch/); // robots.txt disallows
        expect(await o.onTool("submit_findings", { summary: "bad" })).toMatch(/Invalid findings/);
        await o.onTool("submit_findings", {
          summary: "Riverside is a multi-location orthopedic group; billing is run by Robert Alvarez.", ehr: null, size_estimate: null, specialties: ["Orthopedics"],
          pain_points: [], confidence: 0.8,
          decision_makers: [
            { name: "Robert Alvarez", title: "Billing Manager", email: "ralvarez@riverside-ortho.test" },
            { name: "Ghost Person", title: "CEO", email: "ghost@nowhere.test" },
          ],
        });
        return { text: "submitted", usage: { tokensIn: 500, tokensOut: 100 }, steps: 3 };
      },
    });
    const r = await enqueueRun({ kind: "research", leadId });
    await drain(makeDeps({ llm }));
    expect(converseCalls).toBe(1);
    const lead = (await getLead(leadId))!;
    const contacts = await getContacts(lead.organization_id);
    const robert = contacts.find((c) => c.email === "ralvarez@riverside-ortho.test")!;
    expect(robert).toMatchObject({ full_name: "Robert Alvarez", is_decision_maker: true });
    expect(contacts.some((c) => c.email === "ghost@nowhere.test" || c.full_name === "Ghost Person")).toBe(false);
    const profile = (await queryOne<any>("SELECT * FROM research_profiles"))!;
    expect(profile.sources.map((s: any) => s.url)).toContain(`${site.url}/staff-directory`);
    expect(profile.method).toBe("llm");
    const events = (await query("SELECT message FROM agent_events WHERE run_id = $1", [r.id])).map((e: any) => e.message);
    expect(events.some((m: string) => m.includes("starting deep research"))).toBe(true);
    expect(events.some((m: string) => m.startsWith("Deep research done"))).toBe(true);
    expect((await getRun(r.id))!.tokens_in).toBe(1000 + 500);
  });

  it("does NOT run when the first pass is confident and has a reachable decision-maker", async () => {
    const { leadId } = await upsertLead({ name: "Riverside Orthopedics", city: "Austin", state: "TX", website: site.url });
    const llm = new ScriptedLLM({
      json: () => ({ summary: "s", ehr: null, size_estimate: null, specialties: [], pain_points: [], confidence: 0.9, decision_makers: [{ name: "Jane Smith", title: "Practice Manager", email: "jane.smith@riverside-ortho.test" }] }),
      converse: async () => { throw new Error("deep research should not run"); },
    });
    await enqueueRun({ kind: "research", leadId });
    await drain(makeDeps({ llm }));
    expect((await queryOne<any>("SELECT 1 x FROM agent_events WHERE message LIKE '%deep research%'"))).toBeNull();
    expect((await getLead(leadId))!.stage).toBe("researched");
  });

  it("can be switched off, and a failing deep pass keeps first-pass results", async () => {
    const mk = () => new ScriptedLLM({ json: () => ({ summary: "s", ehr: null, size_estimate: null, specialties: [], pain_points: [], decision_makers: [], confidence: 0.2 }), converse: async () => { throw new Error("tool loop exploded"); } });
    const { leadId } = await upsertLead({ name: "Riverside Orthopedics", city: "Austin", state: "TX", website: site.url });
    await enqueueRun({ kind: "research", leadId });
    await drain(makeDeps({ llm: mk() }));
    expect((await queryOne<any>("SELECT message FROM agent_events WHERE message LIKE 'Deep research failed%'"))).not.toBeNull();
    expect((await getLead(leadId))!.stage).toBe("researched");
    process.env.AGENT_DEEP_RESEARCH = "off";
    try {
      await resetDb();
      const l2 = await upsertLead({ name: "Riverside Orthopedics", city: "Austin", state: "TX", website: site.url });
      await enqueueRun({ kind: "research", leadId: l2.leadId });
      await drain(makeDeps({ llm: mk() }));
      expect(await query("SELECT 1 FROM agent_events WHERE message LIKE '%deep research%'")).toHaveLength(0);
    } finally { delete process.env.AGENT_DEEP_RESEARCH; }
  });

  it("mergeExtractions unions people/signals and fills email gaps without downgrading", () => {
    const base: any = { summary: "short", ehr: "Epic", size_estimate: null, specialties: ["A"], pain_points: [{ point: "P1", evidence: "e" }], confidence: 0.4, decision_makers: [{ name: "Jane", title: "PM", email: null }] };
    const extra: any = { summary: "a much longer summary", ehr: "Other", size_estimate: "3 sites", specialties: ["B"], pain_points: [{ point: "p1", evidence: "x" }, { point: "P2", evidence: "y" }], confidence: 0.95, decision_makers: [{ name: "jane", title: "Office Manager", email: "j@x.test" }, { name: "Bob", title: "CFO", email: null }] };
    const m = mergeExtractions(base, extra);
    expect(m.ehr).toBe("Epic");
    expect(m.size_estimate).toBe("3 sites");
    expect(m.decision_makers).toEqual([{ name: "Jane", title: "PM", email: "j@x.test" }, { name: "Bob", title: "CFO", email: null }]);
    expect(m.pain_points.map((p: any) => p.point)).toEqual(["P1", "P2"]);
    expect(m.confidence).toBe(0.9);
    expect(m.summary).toBe("a much longer summary");
  });
});

describe("draft critic, model routing, learning from replies", () => {
  async function leadWithContact(name = "Critic Clinic", specialty = "Orthopedic Surgery") {
    await readySettings();
    const { leadId, organizationId } = await upsertLead({ name, specialty, city: "Austin", state: "TX" });
    await addContact(organizationId, { full_name: "Jane Smith", title: "Practice Manager", email: `jane@${name.split(" ")[0].toLowerCase()}.test`, is_decision_maker: true });
    return leadId;
  }
  const GOOD = "Hi Jane, I saw that your group runs several locations and wanted to introduce our billing team. We help orthopedic practices cut denials and speed up payments so staff spend less time chasing insurers. Would a 15-minute call next week be useful? Best, Sam";
  const BETTER = "Hi Jane, running billing across several locations usually means a lot of denial follow-up. We help orthopedic groups shorten days in A/R without adding headcount. Open to a 15-minute call next week to see if it fits? Best, Sam";

  it("critic revises weak drafts (scoring <8) and leaves strong ones; fast model does the critique", async () => {
    const leadId = await leadWithContact();
    const main = new ScriptedLLM({ json: () => ({ subject: "Billing help", body: GOOD }) });
    const fast = new ScriptedLLM({ json: () => ({ score: 5, issues: ["generic opening"], revised: { subject: "Denials across locations", body: BETTER } }) });
    (fast as any).model = "claude-sonnet-5-5";
    await enqueueRun({ kind: "outreach", leadId, input: { step: 1 } });
    await drain(makeDeps({ llm: main, fastLlm: fast }));
    const m = (await queryOne<any>("SELECT * FROM messages"))!;
    expect(m.subject).toBe("Denials across locations");
    expect(m.body).toContain("shorten days in A/R");
    expect(main.jsonCalls).toHaveLength(1);
    expect(fast.jsonCalls).toHaveLength(1);
    expect(fast.jsonCalls[0].system).toContain("demanding editor");
    expect((await query("SELECT message FROM agent_events WHERE message LIKE 'Critic scored 5/10%'"))).toHaveLength(1);
    // cost: 1000/500 tokens on main (opus 4/20 per M) + same on fast (sonnet 2/10 per M)
    const run = (await queryOne<any>("SELECT cost_usd FROM agent_runs"))!;
    expect(Number(run.cost_usd)).toBeCloseTo((1000 * 4 + 500 * 20 + 1000 * 2 + 500 * 10) / 1e6, 6);

    await resetDb();
    const l2 = await leadWithContact();
    const fast2 = new ScriptedLLM({ json: () => ({ score: 9, issues: [], revised: null }) });
    await enqueueRun({ kind: "outreach", leadId: l2, input: { step: 1 } });
    await drain(makeDeps({ llm: new ScriptedLLM({ json: () => ({ subject: "Billing help", body: GOOD }) }), fastLlm: fast2 }));
    expect((await queryOne<any>("SELECT subject FROM messages"))!.subject).toBe("Billing help");
  });

  it("rejects an invalid critic rewrite and can be disabled", async () => {
    const leadId = await leadWithContact();
    const fast = new ScriptedLLM({ json: () => ({ score: 3, issues: ["bad"], revised: { subject: "Act now", body: "We guarantee 100% results https://x.test [Name] " + GOOD } }) });
    await enqueueRun({ kind: "outreach", leadId, input: { step: 1 } });
    await drain(makeDeps({ llm: new ScriptedLLM({ json: () => ({ subject: "Billing help", body: GOOD }) }), fastLlm: fast }));
    expect((await queryOne<any>("SELECT subject FROM messages"))!.subject).toBe("Billing help");
    process.env.AGENT_CRITIC = "off";
    try {
      await resetDb();
      const l2 = await leadWithContact();
      const f2 = new ScriptedLLM({ json: () => { throw new Error("critic should be off"); } });
      await enqueueRun({ kind: "outreach", leadId: l2, input: { step: 1 } });
      await drain(makeDeps({ llm: new ScriptedLLM({ json: () => ({ subject: "Billing help", body: GOOD }) }), fastLlm: f2 }));
      expect(f2.jsonCalls).toHaveLength(0);
      expect(await query("SELECT 1 FROM messages")).toHaveLength(1);
    } finally { delete process.env.AGENT_CRITIC; }
  });

  it("feeds emails that earned replies (same specialty first) into the next draft prompt", async () => {
    await readySettings();
    // a past win, a past 'not interested', and a past unreplied send
    const mkPast = async (name: string, specialty: string, subject: string, reply: string | null) => {
      const { leadId } = await upsertLead({ name, specialty, city: "X", state: "TX" });
      await query("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, sent_at) VALUES ($1,'outbound',1,'a@b.test',$2,$3,'sent', now())", [leadId, subject, `Body of ${subject}\n\n--\nfooter`]);
      if (reply) await query("INSERT INTO messages (lead_id, direction, to_email, subject, body, status, classification) VALUES ($1,'inbound','a@b.test','Re','x','received',$2)", [leadId, reply]);
    };
    await mkPast("Win Ortho", "Orthopedic Surgery", "WINNER-SUBJECT", "interested");
    await mkPast("Win Cardio", "Cardiology", "OTHER-SPECIALTY-WIN", "question");
    await mkPast("No Ortho", "Orthopedic Surgery", "DECLINED-SUBJECT", "not_interested");
    await mkPast("Silent Ortho", "Orthopedic Surgery", "UNREPLIED-SUBJECT", null);
    const ex = await winningExamples("Orthopedic Surgery");
    expect(ex.map((e) => e.subject)).toEqual(["WINNER-SUBJECT", "OTHER-SPECIALTY-WIN"]);
    expect(ex[0].body).toBe("Body of WINNER-SUBJECT"); // footer stripped

    const leadId = await leadWithContact("New Clinic");
    const main = new ScriptedLLM({ json: () => ({ subject: "Billing help", body: GOOD }) });
    await enqueueRun({ kind: "outreach", leadId, input: { step: 1 } });
    await drain(makeDeps({ llm: main }));
    expect(main.jsonCalls[0].prompt).toContain("earned replies");
    expect(main.jsonCalls[0].prompt).toContain("WINNER-SUBJECT");
    expect(main.jsonCalls[0].prompt).not.toContain("DECLINED-SUBJECT");
    expect(main.jsonCalls[0].prompt).not.toContain("UNREPLIED-SUBJECT");
  });

  it("depsFromEnv wires a cheaper AGENT_MODEL_FAST from the same provider", () => {
    const d = depsFromEnv({ OPENAI_API_KEY: "k", AGENT_MODEL: "big-model", AGENT_MODEL_FAST: "small-model", SKIP_MX_CHECK: "1" });
    expect((d.llm as any).model).toBe("big-model");
    expect((d.fastLlm as any).model).toBe("small-model");
    expect(d.mxCheck).toBe(alwaysDeliverable);
    expect(depsFromEnv({ OPENAI_API_KEY: "k", AGENT_MODEL: "big" }).fastLlm).toBeNull();
    expect(depsFromEnv({}).llm).toBeNull();
  });
});

describe("email domain verification", () => {
  it("dnsMxCheck: MX, address fallback, hard failure, and fail-open on resolver trouble", async () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    const r = (o: any) => ({ resolveMx: async (d: string) => o.mx(d), resolve4: async (d: string) => o.a(d), resolve6: async () => { throw err("ENODATA"); } });
    const check = dnsMxCheck(r({ mx: (d: string) => (d === "good.test" ? [{ exchange: "mx.good.test", priority: 1 }] : d === "aonly.test" ? Promise.reject(err("ENODATA")) : d === "null.test" ? [{ exchange: ".", priority: 0 }] : d === "flaky.test" ? Promise.reject(err("ETIMEOUT")) : Promise.reject(err("ENOTFOUND"))), a: (d: string) => (d === "aonly.test" ? ["1.2.3.4"] : Promise.reject(err("ENOTFOUND"))) }) as any);
    expect(await check("good.test")).toBe(true);
    expect(await check("aonly.test")).toBe(true);
    expect(await check("null.test")).toBe(false);
    expect(await check("dead.test")).toBe(false);
    expect(await check("flaky.test")).toBe(true);
  });

  it("research marks contacts on mail-less domains invalid and does not draft to them", async () => {
    await readySettings();
    const { leadId } = await upsertLead({ name: "Riverside Orthopedics", specialty: "Orthopedic Surgery", city: "Austin", state: "TX", website: site.url });
    await enqueueRun({ kind: "research", leadId, input: { thenOutreach: true } });
    await drain(makeDeps({ mxCheck: async (d) => d !== "riverside-ortho.test" }));
    const cs = await getContacts((await getLead(leadId))!.organization_id);
    expect(cs.filter((c) => c.email).every((c) => c.email_status === "invalid")).toBe(true);
    expect(await query("SELECT 1 FROM messages")).toHaveLength(0);
    const reasons = (await getLead(leadId))!.score_reasons.join(" | ");
    expect(reasons).not.toMatch(/Decision-maker email found|Contact found/); // invalid addresses earn no contact credit
  });
});
