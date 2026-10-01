import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "../src/db";
import { addContact, setStage, upsertLead } from "../src/leads";
import { createTask, updateTask } from "../src/tasks";
import { costPerOutcome, funnel, leadTimeline, outreachStats, replyTiming, weekly, wilson } from "../src/reports";
import { applyEmailEvent } from "../src/tracking";
import { resetDb, setupDb, teardownDb } from "./helpers";

beforeAll(setupDb);
beforeEach(resetDb);
afterAll(teardownDb);

const D = 86400_000;
const t0 = () => new Date(Date.now() - 10 * D);
const at = (days: number) => new Date(t0().getTime() + days * D);

async function sent(leadId: string, step: number, when: Date, variant: string | null, extra: { bounced?: boolean; delivered?: boolean } = {}) {
  return queryOne<any>("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, sent_at, created_at, variant, delivered_at, bounced_at) VALUES ($1,'outbound',$2,'x@y.test','s','b','sent',$3,$3,$4,$5,$6) RETURNING id", [leadId, step, when, variant, extra.delivered ? when : null, extra.bounced ? when : null]);
}
async function inbound(leadId: string, when: Date, classification: string | null) {
  return query("INSERT INTO messages (lead_id, direction, to_email, subject, body, status, created_at, classification) VALUES ($1,'inbound','x@y.test','Re','b','received',$2,$3)", [leadId, when, classification]);
}

/** Lead A (Ortho TX): step1 [A], step2 [AI]; interested reply after step 2. Lead B (Cardio TX): step1 [B], silence.
 *  Lead C (Ortho FL): step1 [A]; out-of-office (ignored) then a "not interested" reply. */
async function seed() {
  const a = await upsertLead({ name: "A Ortho", specialty: "Orthopedics", state: "TX" });
  const b = await upsertLead({ name: "B Cardio", specialty: "Cardiology", state: "TX" });
  const c = await upsertLead({ name: "C Ortho", specialty: "Orthopedics", state: "FL" });
  await sent(a.leadId, 1, at(0), "A", { delivered: true });
  await sent(a.leadId, 2, at(3), null, { delivered: true });
  await sent(b.leadId, 1, at(0), "B", { bounced: true });
  await sent(c.leadId, 1, at(0), "A", { delivered: true });
  await inbound(a.leadId, at(4), "interested");
  await inbound(c.leadId, at(1), "out_of_office");
  await inbound(c.leadId, at(2), "not_interested");
  await query("INSERT INTO research_profiles (lead_id) VALUES ($1), ($2)", [a.leadId, b.leadId]);
  await addContact(a.organizationId, { full_name: "Jane", email: "jane@a.test" });
  await addContact(b.organizationId, { full_name: "Bob", email: "bob@b.test" });
  return { a, b, c };
}
const byGroup = (rows: any[], g: string) => rows.find((r) => r.group === g)!;

describe("statistics helper", () => {
  it("Wilson interval: known values and edge cases", () => {
    expect(wilson(0, 0)).toEqual([0, 0]);
    expect(wilson(5, 10)).toEqual([23.7, 76.3]);
    expect(wilson(50, 100)).toEqual([40.4, 59.6]);
    const [lo, hi] = wilson(0, 20); expect(lo).toBe(0); expect(hi).toBeGreaterThan(10);
    expect(wilson(20, 20)[1]).toBe(100);
  });
});

describe("outreach reports", () => {
  it("attributes each reply to the most recent email before it; out-of-office replies are ignored", async () => {
    await seed();
    const tpl = await outreachStats({ groupBy: "template" });
    expect(byGroup(tpl, "A")).toMatchObject({ sent: 2, delivered: 2, replies: 1, positive: 0, replyRate: 50, enough: false });
    expect(byGroup(tpl, "B")).toMatchObject({ sent: 1, bounced: 1, replies: 0, replyRate: 0 });
    expect(byGroup(tpl, "AI / default")).toMatchObject({ sent: 1, replies: 1, positive: 1, replyRate: 100 }); // lead A's reply belongs to step 2, not step 1
    const step = await outreachStats({ groupBy: "step" });
    expect(byGroup(step, "Step 1")).toMatchObject({ sent: 3, replies: 1, positive: 0 });
    expect(byGroup(step, "Step 2")).toMatchObject({ sent: 1, replies: 1, positive: 1 });
    const spec = await outreachStats({ groupBy: "specialty" });
    expect(byGroup(spec, "Orthopedics")).toMatchObject({ sent: 3, replies: 2, positive: 1 });
    expect(byGroup(spec, "Cardiology")).toMatchObject({ sent: 1, replies: 0 });
    const st = await outreachStats({ groupBy: "state" });
    expect(byGroup(st, "TX").sent).toBe(3);
    expect(byGroup(st, "FL")).toMatchObject({ sent: 1, replies: 1 });
    expect(byGroup(tpl, "A").ci).toEqual(wilson(1, 2));
    await expect(outreachStats({ groupBy: "bogus" as any })).rejects.toThrow(/Invalid grouping/);
  });
  it("time window excludes old sends", async () => {
    const { a } = await seed();
    await sent(a.leadId, 1, new Date(Date.now() - 200 * D), "OLD");
    expect(byGroup(await outreachStats({ groupBy: "template" }), "OLD").sent).toBe(1);
    expect((await outreachStats({ groupBy: "template", days: 30 })).find((r) => r.group === "OLD")).toBeUndefined();
  });
  it("enough=true from 30 sends", async () => {
    const { b } = await seed();
    for (let i = 0; i < 29; i++) await sent(b.leadId, 1, at(1), "BIG");
    await sent(b.leadId, 1, at(1), "BIG");
    expect(byGroup(await outreachStats({ groupBy: "template" }), "BIG")).toMatchObject({ sent: 30, enough: true });
  });
  it("median hours from the preceding send to the reply", async () => {
    await seed();
    expect(await replyTiming()).toEqual({ medianHours: 36, n: 2 }); // 24h (lead A, vs step 2) and 48h (lead C)
    expect((await replyTiming(1)).n).toBe(0);
  });
  it("weekly buckets cover 8 weeks and add up", async () => {
    await seed();
    const w = await weekly(8);
    expect(w).toHaveLength(8);
    expect(w.reduce((n, r) => n + r.sent, 0)).toBe(4);
    expect(w.reduce((n, r) => n + r.replies, 0)).toBe(2);
    expect(w.reduce((n, r) => n + r.bounced, 0)).toBe(1);
  });
});

describe("funnel and cost", () => {
  it("counts leads at the furthest point actually reached, with conversion rates", async () => {
    const { a } = await seed();
    await setStage(a.leadId, "meeting"); // opens a deal
    const f = await funnel();
    const n = (k: string) => f.find((s) => s.key === k)!;
    expect(f.map((s) => [s.key, s.count])).toEqual([["leads", 3], ["researched", 2], ["reachable", 2], ["emailed", 3], ["replied", 2], ["positive", 1], ["meetings", 1], ["won", 0]]);
    expect(n("researched")).toMatchObject({ pctOfPrev: 66.7, pctOfTotal: 66.7 });
    expect(n("emailed")).toMatchObject({ pctOfPrev: 150 });
    expect(n("leads").pctOfPrev).toBeNull();
    await setStage(a.leadId, "won");
    expect((await funnel()).find((s) => s.key === "won")!.count).toBe(1);
  });
  it("AI cost per lead, positive reply and deal", async () => {
    const { a } = await seed();
    await setStage(a.leadId, "meeting");
    await query("INSERT INTO agent_runs (kind, status, cost_usd) VALUES ('research','succeeded',1.25), ('outreach','succeeded',1.75)");
    expect(await costPerOutcome()).toEqual({ spend: 3, perLead: 1, perPositiveReply: 3, perDeal: 3, positive: 1, deals: 1 });
    await resetDb();
    expect(await costPerOutcome()).toMatchObject({ spend: 0, perLead: null, perPositiveReply: null, perDeal: null });
  });
});

describe("lead timeline", () => {
  it("merges emails, replies, stage changes, tasks, deals, runs and delivery events; newest first; sweeps hidden", async () => {
    const { a } = await seed();
    const m = (await query<any>("SELECT id FROM messages WHERE lead_id = $1 AND direction = 'outbound' AND step = 1", [a.leadId]))[0];
    await query("UPDATE messages SET provider_message_id = 'pm1', provider = 'resend' WHERE id = $1", [m.id]);
    await applyEmailEvent({ provider: "resend", type: "delivered", providerMessageId: "pm1", email: "x@y.test", eventId: "e1" });
    await setStage(a.leadId, "meeting");
    const task = (await createTask({ leadId: a.leadId, title: "Call Jane" }))!;
    await updateTask(task.id, { status: "done" });
    await query("INSERT INTO agent_runs (kind, status, lead_id) VALUES ('research','succeeded',$1), ('sweep','succeeded',$1), ('outreach','failed',$1)", [a.leadId]);
    const tl = await leadTimeline(a.leadId);
    const titles = tl.map((t) => t.title);
    expect(titles).toEqual(expect.arrayContaining(["Reply received (interested)", "Email step 1 sent", "Email step 2 sent", "Stage: new → meeting", "Task added: Call Jane", "Task done: Call Jane", "Deal opened: A Ortho - RCM services", "Agent: research succeeded", "Agent: outreach failed", "Email delivered"]));
    expect(titles.some((t) => /sweep/.test(t))).toBe(false);
    const times = tl.map((t) => new Date(t.at).getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(new Set(tl.map((t) => t.kind))).toEqual(new Set(["email", "reply", "stage", "task", "deal", "run", "delivery"]));
    expect(await leadTimeline("not-a-uuid")).toEqual([]);
    expect((await leadTimeline(a.leadId, 3))).toHaveLength(3);
  });
});
