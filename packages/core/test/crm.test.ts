import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "../src/db";
import { enqueueRun } from "../src/queue";
import { processOne } from "../src/agents/worker";
import { addContact, getLead, setStage, upsertLead } from "../src/leads";
import { createTask, dueCount, listTasks, taskCounts, updateTask } from "../src/tasks";
import { createDeal, dealStats, listDeals, updateDeal } from "../src/deals";
import { recordInbound } from "../src/messages";
import { postChatMessage } from "../src/agents/chat";
import { makeDeps, readySettings, resetDb, setupDb, teardownDb } from "./helpers";

beforeAll(setupDb);
beforeEach(resetDb);
afterAll(teardownDb);
const drain = async (deps: any) => { let n = 0; while (n < 40 && (await processOne("t", deps))) n++; };
const days = (n: number) => new Date(Date.now() + n * 86400_000);

describe("tasks", () => {
  it("creates, dedupes, validates", async () => {
    const { leadId } = await upsertLead({ name: "T Clinic" });
    const a = await createTask({ leadId, title: "  Call Jane  ", kind: "call", dedupeKey: "k1" });
    expect(a!.title).toBe("Call Jane");
    expect(await createTask({ leadId, title: "Call Jane again", dedupeKey: "k1" })).toBeNull(); // idempotent
    await expect(createTask({ title: "  " })).rejects.toThrow(/title is required/);
    await expect(createTask({ title: "x", kind: "bogus" as any })).rejects.toThrow(/Invalid task kind/);
    expect((await createTask({ title: "No lead" }))!.lead_id).toBeNull();
  });
  it("buckets: overdue / today / upcoming / done; counts and nav badge", async () => {
    const { leadId } = await upsertLead({ name: "T Clinic" });
    await createTask({ leadId, title: "overdue", dueAt: days(-3) });
    await createTask({ leadId, title: "due now" });
    await createTask({ leadId, title: "later", dueAt: days(5) });
    const done = (await createTask({ leadId, title: "finished", dueAt: days(-1) }))!;
    await updateTask(done.id, { status: "done" });
    expect((await listTasks({ bucket: "overdue" })).map((t) => t.title)).toEqual(["overdue"]);
    expect((await listTasks({ bucket: "today" })).map((t) => t.title)).toEqual(["due now"]);
    expect((await listTasks({ bucket: "upcoming" })).map((t) => t.title)).toEqual(["later"]);
    expect((await listTasks({ bucket: "done" })).map((t) => t.title)).toEqual(["finished"]);
    expect((await listTasks({ bucket: "all" })).map((t) => t.title)).toEqual(["overdue", "due now", "later"]); // open only, by due date
    expect(await taskCounts()).toEqual({ overdue: 1, today: 1, upcoming: 1 });
    expect(await dueCount()).toBe(2);
    expect((await listTasks({ leadId, bucket: "all" }))[0].org_name).toBe("T Clinic");
  });
  it("complete, reopen, snooze and edit", async () => {
    const t = (await createTask({ title: "x" }))!;
    const d = await updateTask(t.id, { status: "done" });
    expect(d.status).toBe("done"); expect(d.completed_at).not.toBeNull();
    const o = await updateTask(t.id, { status: "open", dueAt: days(7), title: "renamed" });
    expect(o).toMatchObject({ status: "open", completed_at: null, title: "renamed" });
    expect(new Date(o.due_at).getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);
    await expect(updateTask(t.id, { title: " " })).rejects.toThrow();
    await expect(updateTask("nope", { status: "done" })).rejects.toThrow(/not found/);
    expect(await query("SELECT 1 FROM audit_log WHERE action IN ('task_done','task_open')")).toHaveLength(2);
  });
});

describe("deals", () => {
  it("manual deal: one open deal per lead, validation, defaults", async () => {
    const { leadId } = await upsertLead({ name: "D Clinic" });
    const d = await createDeal({ leadId, valueUsd: 12000, expectedClose: "2026-12-01" });
    expect(d).toMatchObject({ name: "D Clinic - RCM services", status: "open", source: "manual" });
    expect(Number(d.value_usd)).toBe(12000);
    expect(d.expected_close).toBe("2026-12-01"); // plain date string, not a Date object (it crosses the server/browser boundary)
    expect(typeof (await listDeals({ leadId }))[0].expected_close).toBe("string");
    await expect(createDeal({ leadId })).rejects.toThrow(/already has an open deal/);
    await expect(createDeal({ leadId: (await upsertLead({ name: "Other" })).leadId, valueUsd: -5 })).rejects.toThrow(/non-negative/);
    await expect(createDeal({ leadId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(/Lead not found/);
  });
  it("moving a lead to Meeting opens a deal once; Won closes it; Lost closes it and drops open tasks", async () => {
    const { leadId } = await upsertLead({ name: "Pipeline Clinic" });
    await createTask({ leadId, title: "follow up" });
    await setStage(leadId, "meeting");
    await setStage(leadId, "replied"); await setStage(leadId, "meeting");
    expect(await listDeals({ leadId, status: "open" })).toHaveLength(1);
    await updateDeal((await listDeals({ leadId }))[0].id, { valueUsd: 9000 });
    await setStage(leadId, "won");
    const d = (await listDeals({ leadId }))[0];
    expect(d).toMatchObject({ status: "won", source: "auto" }); expect(d.closed_at).not.toBeNull();
    expect((await listTasks({ leadId })).length).toBe(1); // winning keeps follow-ups

    const l2 = (await upsertLead({ name: "Lost Clinic" })).leadId;
    await createTask({ leadId: l2, title: "will be dropped" });
    await setStage(l2, "meeting"); await setStage(l2, "lost");
    expect((await listDeals({ leadId: l2 }))[0].status).toBe("lost");
    expect(await listTasks({ leadId: l2 })).toHaveLength(0);
    expect((await queryOne<any>("SELECT status FROM tasks WHERE lead_id = $1", [l2]))!.status).toBe("dismissed");

    const l3 = (await upsertLead({ name: "Straight Win" })).leadId; // won without ever having a meeting stage: still recorded
    await setStage(l3, "won");
    expect((await listDeals({ leadId: l3 }))[0]).toMatchObject({ status: "won" });
    await setStage(l3, "won");
    expect(await listDeals({ leadId: l3 })).toHaveLength(1);
  });
  it("closing a deal moves the lead; reopening is guarded; stats and win rate", async () => {
    const mk = async (n: string, v: number) => { const { leadId } = await upsertLead({ name: n }); return { leadId, deal: await createDeal({ leadId, valueUsd: v }) }; };
    const a = await mk("A", 10000), b = await mk("B", 5000), c = await mk("C", 2500), d = await mk("D", 700);
    await updateDeal(a.deal.id, { status: "won" });
    await updateDeal(b.deal.id, { status: "lost" });
    await updateDeal(c.deal.id, { status: "won" });
    expect((await getLead(a.leadId))!.stage).toBe("won");
    expect((await getLead(b.leadId))!.stage).toBe("lost");
    const s = await dealStats();
    expect(s).toMatchObject({ open: { count: 1, value: 700 }, won: { count: 2, value: 12500 }, lost: { count: 1 }, winRate: 66.7 });
    const reopened = await updateDeal(b.deal.id, { status: "open" });
    expect(reopened.closed_at).toBeNull();
    expect((await getLead(b.leadId))!.stage).toBe("meeting");
    const x = await createDeal({ leadId: a.leadId });
    await expect(updateDeal(a.deal.id, { status: "open" })).rejects.toThrow(/another open deal/);
    expect(x.status).toBe("open");
    await expect(updateDeal(d.deal.id, { valueUsd: -1 })).rejects.toThrow(/non-negative/);
    await expect(updateDeal(d.deal.id, { expectedClose: "not a date" })).rejects.toThrow(/Invalid expected close/);
    expect((await updateDeal(d.deal.id, { expectedClose: null, notes: "n" })).notes).toBe("n");
    expect((await dealStats()).avgDaysToWin).toBeGreaterThanOrEqual(0);
  });
});

describe("automatic tasks", () => {
  async function contacted() {
    await readySettings();
    const { leadId, organizationId } = await upsertLead({ name: "Auto Clinic", specialty: "Orthopedic Surgery", website: "https://practice.test" });
    await addContact(organizationId, { full_name: "Jane Smith", email: "jane@practice.test", is_decision_maker: true });
    await setStage(leadId, "contacted");
    await query("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, sent_at, unsub_token) VALUES ($1,'outbound',1,'jane@practice.test','Hi','b','sent', now(), 't')", [leadId]);
    return leadId;
  }
  it("interested reply → 'Reply to' task due now; not now → check-back task in 90 days; both idempotent; question → answer task", async () => {
    const leadId = await contacted();
    await recordInbound({ from: "jane@practice.test", subject: "Re: Hi", body: "Sounds good, let's schedule a call." });
    const deps = makeDeps();
    await drain(deps);
    let tasks = await listTasks({ leadId });
    expect(tasks.map((t) => t.title)).toEqual(["Reply to Jane Smith (Auto Clinic): wants to talk"]);
    expect(tasks[0]).toMatchObject({ kind: "email", source: "reply" });
    // processing the same inbound again must not duplicate
    const inbound = await queryOne<any>("SELECT id FROM messages WHERE direction = 'inbound'");
    await enqueueRun({ kind: "reply", leadId, input: { messageId: inbound.id }, idempotencyKey: "again" });
    await drain(deps);
    expect(await listTasks({ leadId })).toHaveLength(1);

    await resetDb();
    const l2 = await contacted();
    await recordInbound({ from: "jane@practice.test", subject: "Re: Hi", body: "Not right now, maybe next quarter." });
    await drain(makeDeps());
    const t2 = (await listTasks({ leadId: l2 }))[0];
    expect(t2.title).toBe("Check back with Auto Clinic");
    expect((new Date(t2.due_at).getTime() - Date.now()) / 86400_000).toBeGreaterThan(88);

    await resetDb();
    const l3 = await contacted();
    await recordInbound({ from: "jane@practice.test", subject: "Re: Hi", body: "Which EHRs do you support?" });
    await drain(makeDeps());
    expect((await listTasks({ leadId: l3 }))[0].title).toBe("Answer Jane Smith's question (Auto Clinic)");
  });
  it("a lead with no reachable contact gets a 'find a contact' task (once)", async () => {
    const { leadId } = await upsertLead({ name: "Nobody Home", city: "X", state: "TX" });
    await enqueueRun({ kind: "contacts", leadId });
    await drain(makeDeps());
    await enqueueRun({ kind: "contacts", leadId, idempotencyKey: "second" });
    await drain(makeDeps());
    const t = await listTasks({ leadId });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ title: "Find a contact email for Nobody Home", kind: "research" });
  });
});

describe("chat: tasks", () => {
  it("rule-based 'tasks' summary and the add/list tools", async () => {
    const { leadId } = await upsertLead({ name: "Chat Clinic" });
    await createTask({ leadId, title: "Call Chat Clinic", dueAt: days(-2) });
    const ask = async (t: string) => { const { runId } = await postChatMessage("t", t); await drain(makeDeps()); return (await queryOne<any>("SELECT content FROM chat_messages WHERE run_id = $1", [runId]))!.content as string; };
    expect(await ask("tasks")).toMatch(/1 overdue, 0 due today, 0 upcoming[\s\S]*Call Chat Clinic/);
    await query("DELETE FROM tasks");
    expect(await ask("tasks")).toBe("No open tasks.");
  });
});
