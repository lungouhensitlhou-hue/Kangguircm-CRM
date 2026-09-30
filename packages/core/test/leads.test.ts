import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addContact, getContacts, getLead, importRows, listLeads, parseCsv, pipelineStats, setStage, updateLead, upsertLead } from "../src/leads";
import { query } from "../src/db";
import { getSettings, saveSettings } from "../src/settings";
import { resetDb, setupDb, teardownDb } from "./helpers";

beforeAll(setupDb);
beforeEach(resetDb);
afterAll(teardownDb);

describe("leads", () => {
  it("dedupes by NPI and by name+city+state", async () => {
    const a = await upsertLead({ name: "Riverside Ortho", npi: "111", city: "Austin", state: "tx" });
    const b = await upsertLead({ name: "Other name", npi: "111" });
    const c = await upsertLead({ name: "riverside ORTHO", city: "austin", state: "TX" });
    const d = await upsertLead({ name: "Riverside Ortho", city: "Dallas", state: "TX" });
    expect(a.created).toBe(true);
    expect(b.leadId).toBe(a.leadId);
    expect(c.leadId).toBe(a.leadId);
    expect(d.leadId).not.toBe(a.leadId);
    expect((await query("SELECT count(*)::int n FROM leads"))[0].n).toBe(2);
    await expect(upsertLead({ name: "  " })).rejects.toThrow();
  });

  it("filters, searches and sorts", async () => {
    await upsertLead({ name: "Alpha Cardiology", specialty: "Cardiology", city: "Austin", state: "TX" });
    await upsertLead({ name: "Beta Pediatrics", specialty: "Pediatrics", city: "Miami", state: "FL" });
    const b = await upsertLead({ name: "Gamma Ortho", specialty: "Orthopedics", city: "Austin", state: "TX" });
    await query("UPDATE leads SET score = 90 WHERE id = $1", [b.leadId]);
    expect((await listLeads({ state: "tx" })).total).toBe(2);
    expect((await listLeads({ q: "miami" })).rows[0].org.name).toBe("Beta Pediatrics");
    expect((await listLeads({ specialty: "ortho" })).total).toBe(1);
    expect((await listLeads({ minScore: 50 })).total).toBe(1);
    expect((await listLeads({})).rows[0].org.name).toBe("Gamma Ortho");
    expect((await listLeads({ sort: "name" })).rows[0].org.name).toBe("Alpha Cardiology");
    expect((await listLeads({ stage: "bogus" })).total).toBe(3);
    expect((await listLeads({ q: "x'; DROP TABLE leads;--" })).total).toBe(0);
  });

  it("stage changes are validated and audited", async () => {
    const { leadId } = await upsertLead({ name: "X Clinic" });
    await setStage(leadId, "researched", "tester");
    expect((await getLead(leadId))!.stage).toBe("researched");
    await expect(setStage(leadId, "bogus" as any)).rejects.toThrow(/Invalid stage/);
    await updateLead(leadId, { notes: "hello" });
    expect((await getLead(leadId))!.notes).toBe("hello");
    const a = await query("SELECT * FROM audit_log");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor: "tester", action: "stage_change" });
    expect(await getLead("not-a-uuid")).toBeNull();
  });

  it("contacts dedupe by email and reject invalid ones", async () => {
    const { organizationId } = await upsertLead({ name: "X Clinic" });
    await addContact(organizationId, { full_name: "Jane", email: "Jane@X.com", title: "Practice Manager", is_decision_maker: true });
    await addContact(organizationId, { full_name: "Jane S", email: "jane@x.com" });
    expect(await addContact(organizationId, { email: "garbage" })).toBeNull();
    const cs = await getContacts(organizationId);
    expect(cs).toHaveLength(1);
    expect(cs[0].email).toBe("jane@x.com");
    expect(cs[0].is_decision_maker).toBe(true);
  });

  it("imports CSV with aliases and contacts", async () => {
    const csv = "Practice Name,City,State,Website,Contact Name,Contact Email,Title\nAcme Ortho,Austin,TX,acme.com,Pat Lee,pat@acme.com,Practice Manager\nAcme Ortho,Austin,TX,,,,\n,Nowhere,TX,,,,\nBeta Urgent Care,Miami,FL,,,info@beta.com,\n";
    const r = await importRows(parseCsv(csv));
    expect(r).toEqual({ created: 2, existing: 1, skipped: 1, contacts: 2 });
    const { rows } = await listLeads({ q: "acme" });
    expect(rows[0].org.website).toBe("https://acme.com");
    const cs = await getContacts(rows[0].organization_id);
    expect(cs[0]).toMatchObject({ email: "pat@acme.com", is_decision_maker: true });
  });

  it("pipeline stats", async () => {
    const a = await upsertLead({ name: "A" });
    await upsertLead({ name: "B" });
    await setStage(a.leadId, "contacted");
    const s = await pipelineStats();
    expect(s.total).toBe(2);
    expect(s.byStage.new).toBe(1);
    expect(s.byStage.contacted).toBe(1);
  });
});

describe("settings", () => {
  it("returns defaults, persists patches and validates", async () => {
    expect((await getSettings()).dailySendCap).toBe(25);
    const s = await saveSettings({ dailySendCap: 40, physicalAddress: "1 St" });
    expect(s.dailySendCap).toBe(40);
    expect((await getSettings()).physicalAddress).toBe("1 St");
    await expect(saveSettings({ dailySendCap: -1 })).rejects.toThrow();
    await expect(saveSettings({ senderEmail: "nope" })).rejects.toThrow();
  });
});
