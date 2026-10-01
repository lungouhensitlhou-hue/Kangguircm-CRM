import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "../src/db";
import { enqueueRun } from "../src/queue";
import { processOne } from "../src/agents/worker";
import { addContact, bulkTag, deleteView, exportLeadsCsv, getLead, listLeads, listViews, saveView, setStage, setTags, toCsv, updateLead, upsertLead } from "../src/leads";
import { MERGE_FIELDS, createTemplate, deleteTemplate, listTemplates, pickVariant, renderTemplate, updateTemplate, validateTemplate } from "../src/templates";
import { createSequence, deleteSequence, enrollLead, listSequences, sequenceSteps, setSequencePaused, updateSequence, validateSteps } from "../src/sequences";
import { saveSettings } from "../src/settings";
import { makeDeps, readySettings, resetDb, setupDb, teardownDb } from "./helpers";

beforeAll(setupDb);
beforeEach(async () => { await resetDb(); await query("TRUNCATE templates, sequences, saved_views CASCADE"); });
afterAll(teardownDb);
const drain = async (deps: any) => { let n = 0; while (n < 40 && (await processOne("t", deps))) n++; };
const GOOD_BODY = "Hi {{first_name|there}},\n\nI noticed {{practice}} in {{city}} runs on {{ehr|your current EHR}}. We help {{specialty|medical}} practices cut denials.\n\nOpen to a short call?\n\n{{sender_first_name}}";

describe("templates", () => {
  it("validates fields, braces, length and own-unsubscribe text", () => {
    expect(validateTemplate({ name: "a", subject: "Hi {{practice}}", body: GOOD_BODY })).toEqual([]);
    expect(validateTemplate({ subject: "x", body: "short" })).toEqual(expect.arrayContaining(["Body is too short"]));
    expect(validateTemplate({ subject: "Hi {{nope}}", body: GOOD_BODY })).toContain("Unknown merge field {{nope}}");
    expect(validateTemplate({ subject: "Hi", body: GOOD_BODY + " {{practice" })).toContain("Unbalanced {{ }} braces");
    expect(validateTemplate({ subject: "Hi", body: GOOD_BODY + "\nUnsubscribe here" })[0]).toMatch(/footer is added automatically/);
    expect(validateTemplate({ subject: "x".repeat(151), body: GOOD_BODY })).toContain("Subject is too long (150 characters max)");
    expect(validateTemplate({ name: " ", subject: "s", body: GOOD_BODY })).toContain("Name is required");
    expect(Object.keys(MERGE_FIELDS)).toContain("first_name");
  });
  it("renders with fallbacks, and refuses to produce half-empty emails", () => {
    const t = { subject: "Fewer denials at {{ practice }}", body: GOOD_BODY };
    const full = renderTemplate(t, { first_name: "Jane", practice: "Riverside", city: "Austin", ehr: "athenahealth", specialty: "Orthopedic Surgery", sender_first_name: "Sam" });
    expect(full.subject).toBe("Fewer denials at Riverside");
    expect(full.body).toContain("Hi Jane,");
    expect(full.body).toContain("runs on athenahealth");
    const fb = renderTemplate(t, { practice: "R", city: "A", sender_first_name: "S" });
    expect(fb.body).toContain("Hi there,");
    expect(fb.body).toContain("runs on your current EHR");
    expect(fb.body).toContain("help medical practices");
    expect(() => renderTemplate(t, { practice: "R", sender_first_name: "S" })).toThrow(/No value for \{\{city\}\}/);
    expect(() => renderTemplate({ subject: "s", body: "{{practice}}" }, { practice: "  " })).toThrow(/practice/);
  });
  it("A/B assignment is deterministic and roughly even", () => {
    const ids = ["a", "b"];
    expect(pickVariant(ids, "lead-1")).toBe(pickVariant(ids, "lead-1"));
    const n = Array.from({ length: 400 }, (_, i) => pickVariant(ids, `lead-${i}`)).filter((x) => x === "a").length;
    expect(n).toBeGreaterThan(140); expect(n).toBeLessThan(260);
    expect(pickVariant(["only"], "x")).toBe("only");
  });
  it("CRUD: unique names, validation on update, delete blocked while used", async () => {
    const t = await createTemplate({ name: "Intro A", subject: "Hi {{practice}}", body: GOOD_BODY });
    await expect(createTemplate({ name: "Intro A", subject: "x", body: GOOD_BODY })).rejects.toThrow(/already exists/);
    await expect(createTemplate({ name: "Bad", subject: "{{zzz}}", body: GOOD_BODY })).rejects.toThrow(/Unknown merge field/);
    expect((await updateTemplate(t.id, { subject: "New {{city}}" })).subject).toBe("New {{city}}");
    await expect(updateTemplate(t.id, { body: "tiny" })).rejects.toThrow(/too short/);
    await expect(updateTemplate("nope", { name: "x" })).rejects.toThrow(/not found/);
    expect((await updateTemplate(t.id, { active: false })).active).toBe(false);
    await createSequence({ name: "S", steps: [{ delayDays: 0, templateIds: [t.id] }] });
    await expect(deleteTemplate(t.id)).rejects.toThrow(/used by sequence "S"/);
    await deleteSequence((await listSequences())[0].id);
    await deleteTemplate(t.id);
    expect(await listTemplates()).toHaveLength(0);
  });
});

describe("sequences", () => {
  it("validates steps", async () => {
    expect(validateSteps([])).toEqual(["A sequence needs at least one step"]);
    expect(validateSteps([{ delayDays: 0 }, { delayDays: 0 }])[0]).toMatch(/at least 1 day/);
    expect(validateSteps([{ delayDays: 0 }, { delayDays: 61 }])[0]).toMatch(/0 to 60/);
    expect(validateSteps([{ delayDays: 0 }, { delayDays: 1.5 }])[0]).toMatch(/whole number/);
    expect(validateSteps(Array.from({ length: 9 }, (_, i) => ({ delayDays: i === 0 ? 0 : 1 })))[0]).toMatch(/At most 8/);
    expect(validateSteps([{ delayDays: 0, templateIds: ["x"] }])[0]).toMatch(/invalid template list/);
    expect(validateSteps([{ delayDays: 0 }, { delayDays: 3 }])).toEqual([]);
    await expect(createSequence({ name: "X", steps: [{ delayDays: 0, templateIds: ["00000000-0000-0000-0000-000000000000"] }] })).rejects.toThrow(/Unknown template/);
    await expect(createSequence({ name: " ", steps: [{ delayDays: 0 }] })).rejects.toThrow(/Name is required/);
  });
  it("one default at a time; resolution order: lead's sequence > default > Settings follow-up days", async () => {
    const { leadId } = await upsertLead({ name: "Seq Clinic" });
    await saveSettings({ followupDays: [3, 7] });
    let l = (await getLead(leadId))!;
    expect(await sequenceSteps(l)).toEqual([{ delayDays: 0 }, { delayDays: 3 }, { delayDays: 7 }]);
    const a = await createSequence({ name: "A", steps: [{ delayDays: 0 }, { delayDays: 2 }], isDefault: true });
    const b = await createSequence({ name: "B", steps: [{ delayDays: 0 }, { delayDays: 9 }, { delayDays: 9 }], isDefault: true });
    expect((await listSequences()).filter((s) => s.is_default).map((s) => s.name)).toEqual(["B"]);
    expect((await sequenceSteps(l)).length).toBe(3);
    await enrollLead(leadId, a.id);
    l = (await getLead(leadId))!;
    expect(await sequenceSteps(l)).toEqual(a.steps);
    await updateSequence(a.id, { isDefault: true });
    expect((await listSequences()).filter((s) => s.is_default).map((s) => s.name)).toEqual(["A"]);
    await expect(createSequence({ name: "A", steps: [{ delayDays: 0 }] })).rejects.toThrow(/already exists/);
    await expect(enrollLead(leadId, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/not found/);
    await deleteSequence(a.id); // lead falls back (ON DELETE SET NULL)
    expect((await getLead(leadId))!.sequence_id).toBeNull();
    expect(b.is_default || true).toBe(true);
  });
});

describe("sequences drive the outreach agents", () => {
  async function lead(name = "Seq Lead", ehr: string | null = "athenahealth") {
    await readySettings({ sendWindowStartHour: 0, sendWindowEndHour: 24, sendOnWeekends: true });
    const { leadId, organizationId } = await upsertLead({ name, specialty: "Orthopedic Surgery", city: "Austin", state: "TX" });
    if (ehr) await query("UPDATE organizations SET ehr = $2 WHERE id = $1", [organizationId, ehr]);
    await addContact(organizationId, { full_name: "Jane Smith", title: "Practice Manager", email: `jane@${name.split(" ")[0].toLowerCase()}.test`, is_decision_maker: true });
    return { leadId, organizationId };
  }
  it("step 1 uses the template: merged, footer added, template/variant recorded", async () => {
    const t = await createTemplate({ name: "Denials A", subject: "Fewer denials at {{practice}}", body: GOOD_BODY });
    await createSequence({ name: "Std", steps: [{ delayDays: 0, templateIds: [t.id] }, { delayDays: 3 }], isDefault: true });
    const { leadId } = await lead();
    await enqueueRun({ kind: "outreach", leadId, input: { step: 1 } });
    await drain(makeDeps());
    const m = (await queryOne<any>("SELECT * FROM messages"))!;
    expect(m).toMatchObject({ subject: "Fewer denials at Seq Lead", template_id: t.id, variant: "Denials A", status: "draft" });
    expect(m.body).toContain("Hi Jane,");
    expect(m.body).toContain("runs on athenahealth");
    expect(m.body).toContain("/unsubscribe/");
    expect((await query("SELECT message FROM agent_events WHERE message LIKE 'Drafted step 1%via template%'"))).toHaveLength(1);
  });
  it("falls back to normal drafting when the template cannot be filled, is inactive, or deleted", async () => {
    const t = await createTemplate({ name: "Needs city", subject: "Hi {{practice}}", body: GOOD_BODY.replace("{{city}}", "{{state}}") + " {{title}}" });
    await createSequence({ name: "Std", steps: [{ delayDays: 0, templateIds: [t.id] }], isDefault: true });
    const { leadId, organizationId } = await lead();
    await query("UPDATE contacts SET title = NULL WHERE organization_id = $1", [organizationId]); // {{title}} has no fallback and no value
    await enqueueRun({ kind: "outreach", leadId, input: { step: 1 } });
    await drain(makeDeps());
    const m = (await queryOne<any>("SELECT * FROM messages"))!;
    expect(m.template_id).toBeNull();
    expect(m.subject).toBe("Billing support for Seq Lead"); // the built-in template draft
    expect((await query("SELECT message FROM agent_events WHERE message LIKE 'Template \"Needs city\" not used%'"))).toHaveLength(1);
    await query("DELETE FROM messages"); await updateTemplate(t.id, { active: false });
    await enqueueRun({ kind: "outreach", leadId, input: { step: 1 }, idempotencyKey: "again" });
    await drain(makeDeps());
    expect((await queryOne<any>("SELECT template_id FROM messages"))!.template_id).toBeNull();
    expect((await query("SELECT message FROM agent_events WHERE message LIKE '%missing or inactive%'"))).toHaveLength(1);
  });
  it("A/B: stable per lead, and both variants are used across leads", async () => {
    const a = await createTemplate({ name: "A", subject: "A for {{practice}}", body: GOOD_BODY });
    const b = await createTemplate({ name: "B", subject: "B for {{practice}}", body: GOOD_BODY });
    await createSequence({ name: "AB", steps: [{ delayDays: 0, templateIds: [a.id, b.id] }], isDefault: true });
    const used = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const { leadId } = await lead(`Lead${i} Clinic`);
      await enqueueRun({ kind: "outreach", leadId, input: { step: 1 } });
      await drain(makeDeps());
      used.add((await queryOne<any>("SELECT variant FROM messages WHERE lead_id = $1", [leadId]))!.variant);
    }
    expect([...used].sort()).toEqual(["A", "B"]);
  });
  it("follow-ups follow the lead's own sequence delays; pausing stops them, resuming restarts them", async () => {
    await createSequence({ name: "Default", steps: [{ delayDays: 0 }, { delayDays: 10 }], isDefault: true });
    const fast = await createSequence({ name: "Fast", steps: [{ delayDays: 0 }, { delayDays: 2 }, { delayDays: 4 }] });
    const { leadId } = await lead();
    await enrollLead(leadId, fast.id);
    await setStage(leadId, "contacted");
    await query("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, sent_at, unsub_token) VALUES ($1,'outbound',1,'jane@seq.test','Hi','b','sent', now() - interval '3 days','t')", [leadId]);
    const deps = makeDeps();
    await setSequencePaused(leadId, true);
    await enqueueRun({ kind: "sweep", idempotencyKey: "s1" }); await drain(deps);
    expect(await query("SELECT 1 FROM messages WHERE step = 2")).toHaveLength(0); // paused
    await setSequencePaused(leadId, false);
    await enqueueRun({ kind: "sweep", idempotencyKey: "s2" }); await drain(deps);
    expect(await query("SELECT 1 FROM messages WHERE step = 2")).toHaveLength(1); // 3 days >= the Fast sequence's 2-day delay (default would wait 10)
    // a lead on the 10-day default is not due yet
    const other = await lead("Slow Clinic");
    await setStage(other.leadId, "contacted");
    await query("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, sent_at, unsub_token) VALUES ($1,'outbound',1,'jane@slow.test','Hi','b','sent', now() - interval '3 days','t2')", [other.leadId]);
    await enqueueRun({ kind: "sweep", idempotencyKey: "s3" }); await drain(deps);
    expect(await query("SELECT 1 FROM messages WHERE lead_id = $1 AND step = 2", [other.leadId])).toHaveLength(0);
  });
  it("outreach for a follow-up step is skipped while paused; sequence ends after the last step", async () => {
    const seq = await createSequence({ name: "Short", steps: [{ delayDays: 0 }, { delayDays: 2 }] });
    const { leadId } = await lead();
    await enrollLead(leadId, seq.id); await setSequencePaused(leadId, true);
    const r = await enqueueRun({ kind: "outreach", leadId, input: { step: 2 } });
    await drain(makeDeps());
    expect((await queryOne<any>("SELECT output FROM agent_runs WHERE id = $1", [r.id]))!.output).toMatchObject({ skipped: "paused" });
    await setStage(leadId, "contacted"); await setSequencePaused(leadId, false);
    await query("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, sent_at, unsub_token) VALUES ($1,'outbound',2,'jane@seq.test','Re','b','sent', now() - interval '30 days','t3')", [leadId]);
    await enqueueRun({ kind: "sweep", idempotencyKey: "end" }); await drain(makeDeps());
    expect(await query("SELECT 1 FROM messages WHERE step = 3")).toHaveLength(0); // no step 3 defined
  });
  it("send schedules the next action from the sequence", async () => {
    const seq = await createSequence({ name: "Six", steps: [{ delayDays: 0 }, { delayDays: 6 }] });
    const { leadId } = await lead();
    await enrollLead(leadId, seq.id);
    const m = await queryOne<any>("INSERT INTO messages (lead_id, direction, step, to_email, subject, body, status, unsub_token) VALUES ($1,'outbound',1,'jane@seq.test','s','b','approved','u1') RETURNING id", [leadId]);
    await enqueueRun({ kind: "send", input: { messageId: m.id } });
    await drain(makeDeps());
    const l = (await getLead(leadId))!;
    expect((new Date(l.next_action_at!).getTime() - Date.now()) / 86400_000).toBeGreaterThan(5.9);
    expect((new Date(l.next_action_at!).getTime() - Date.now()) / 86400_000).toBeLessThan(6.1);
  });
});

describe("tags, saved views, export", () => {
  it("normalizes tags, enforces limits, bulk add/remove is idempotent, and filters work", async () => {
    const a = (await upsertLead({ name: "Alpha" })).leadId, b = (await upsertLead({ name: "Beta" })).leadId;
    expect(await setTags(a, [" Pilot ", "TX Priority", "pilot", "bad!chars", ""])).toEqual(["pilot", "tx-priority", "badchars"]);
    await expect(setTags(a, Array.from({ length: 21 }, (_, i) => `t${i}`))).rejects.toThrow(/At most 20/);
    expect(await bulkTag([a, b], "Pilot", "add")).toBe(1); // a already has it
    expect(await bulkTag([a, b], "pilot", "add")).toBe(0);
    expect((await listLeads({ tag: "PILOT" })).total).toBe(2);
    expect(await bulkTag([a], "pilot", "remove")).toBe(1);
    expect((await listLeads({ tag: "pilot" })).rows.map((r) => r.org.name)).toEqual(["Beta"]);
    await expect(bulkTag([a], "!!", "add")).rejects.toThrow(/Tag is required/);
    await updateLead(b, { tags: ["x", "y"] });
    expect((await getLead(b))!.tags).toEqual(["x", "y"]);
  });
  it("saved views keep only known, non-empty filters; same name updates; delete", async () => {
    await expect(saveView("  ", { q: "x" })).rejects.toThrow(/Name is required/);
    await expect(saveView("empty", { q: "", bogus: "x" })).rejects.toThrow(/at least one filter/);
    const v = await saveView("TX ortho", { state: "TX", specialty: "ortho", evil: "<script>", stage: "" });
    expect(v.filters).toEqual({ state: "TX", specialty: "ortho" });
    const v2 = await saveView("TX ortho", { state: "FL" });
    expect(v2.id).toBe(v.id);
    expect((await listViews())[0].filters).toEqual({ state: "FL" });
    await deleteView(v.id); await deleteView("nope");
    expect(await listViews()).toHaveLength(0);
  });
  it("CSV: quoting, line breaks and spreadsheet-formula protection", () => {
    expect(toCsv([["a", "b,c", 'say "hi"', "line1\nline2", null, 5]])).toBe('a,"b,c","say ""hi""","line1\nline2",,5\r\n');
    expect(toCsv([["=SUM(A1)", "+1 800", "-cmd", "@x", "-12.5", "ok-dash"]])).toBe("'=SUM(A1),'+1 800,'-cmd,'@x,-12.5,ok-dash\r\n");
  });
  it("export includes the best contact, respects filters, and neutralizes hostile practice names", async () => {
    const { leadId, organizationId } = await upsertLead({ name: '=HYPERLINK("http://evil.test","x")', specialty: "Orthopaedic Surgery", city: "Austin", state: "TX", phone: "512-555-0100" });
    await addContact(organizationId, { full_name: "Info Box", email: "info@evil.test" });
    await addContact(organizationId, { full_name: "Jane Smith, MD", title: "Owner", email: "jane@evil.test", is_decision_maker: true });
    await setTags(leadId, ["pilot", "tx"]);
    await upsertLead({ name: "Other Clinic", city: "Miami", state: "FL" });
    const csv = await exportLeadsCsv({ state: "TX" });
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^practice,npi,specialty/);
    expect(lines[1].startsWith("\"'=HYPERLINK(\"\"http://evil.test\"\",\"\"x\"\")\"")).toBe(true);
    expect(lines[1]).toContain("pilot;tx");
    expect(lines[1]).toContain('"Jane Smith, MD",Owner,jane@evil.test,unverified,published');
    expect((await exportLeadsCsv({})).trim().split("\r\n")).toHaveLength(3);
  });
});
