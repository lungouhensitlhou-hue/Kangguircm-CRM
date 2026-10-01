import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "../src/db";
import { enqueueRun, getRun } from "../src/queue";
import { processOne } from "../src/agents/worker";
import { getContacts, upsertLead } from "../src/leads";
import { mapAuthorizedOfficial, mapNpiResult, NppesClient, primaryMatches } from "../src/providers/npi";
import { makeDeps, resetDb, setupDb, teardownDb } from "./helpers";

beforeAll(setupDb);
beforeEach(resetDb);
afterAll(teardownDb);

/** A REAL NPPES v2.1 organization record (NPI 1184173221), captured live from the registry. */
const REAL = {
  number: "1184173221", enumeration_type: "NPI-2",
  basic: { authorized_official_credential: "MD", authorized_official_first_name: "HUONG", authorized_official_last_name: "LE", authorized_official_middle_name: "T", authorized_official_name_prefix: "--", authorized_official_name_suffix: "--", authorized_official_telephone_number: "2815863888", authorized_official_title_or_position: "OWNER", enumeration_date: "2016-09-30", last_updated: "2016-09-30", organization_name: "1960 FAMILY PRACTICE, PA", organizational_subpart: "NO", status: "A" },
  addresses: [
    { address_1: "20320 NORTHWEST FWY", address_2: "SUITE 900", address_purpose: "MAILING", city: "JERSEY VILLAGE", country_code: "US", postal_code: "770655641", state: "TX", telephone_number: "281-453-7232" },
    { address_1: "3550 RAYFORD RD", address_2: "SUITE 110A", address_purpose: "LOCATION", city: "SPRING", country_code: "US", postal_code: "773864343", state: "TX", telephone_number: "281-586-3888" },
  ],
  taxonomies: [
    { code: "207Q00000X", desc: "Family Medicine", primary: false }, { code: "207X00000X", desc: "Orthopaedic Surgery", primary: false },
    { code: "208D00000X", desc: "General Practice", primary: true },
  ],
};

/** A second REAL record (NPI 1417554353): no middle name or credential, acronym title, DBA name. */
const REAL2 = {
  number: "1417554353", enumeration_type: "NPI-2",
  basic: { authorized_official_first_name: "JENNIFER", authorized_official_last_name: "KINMAN", authorized_official_telephone_number: "5124391000", authorized_official_title_or_position: "CEO", organization_name: "ORTHOLONESTAR, PLLC", organizational_subpart: "YES", status: "A" },
  addresses: [
    { address_1: "4700 SETON CENTER PKWY STE 200", address_purpose: "MAILING", city: "AUSTIN", postal_code: "787594107", state: "TX", telephone_number: "512-439-1000" },
    { address_1: "1401 MEDICAL PKWY STE 109B", address_purpose: "LOCATION", city: "CEDAR PARK", postal_code: "786135012", state: "TX", telephone_number: "512-439-1000" },
  ],
  other_names: [{ code: "3", organization_name: "TEXAS ORTHOPEDICS, SPORTS & REHABILITATION ASSOCIATES", type: "Doing Business As" }],
  taxonomies: [{ code: "207X00000X", desc: "Orthopaedic Surgery", primary: true }],
};

describe("registry mapping against a real record", () => {
  it("second real record: acronym titles stay upper-case, DBA becomes an alias, missing middle/credential handled", () => {
    const o = mapNpiResult(REAL2)!;
    expect(o).toMatchObject({ name: "Ortholonestar, PLLC", specialty: "Orthopaedic Surgery", city: "Cedar Park", zip: "78613" });
    expect(o.official).toEqual({ name: "Jennifer Kinman", title: "CEO", phone: "512-439-1000", credential: null });
    expect(o.aliases).toEqual(["Texas Orthopedics, Sports & Rehabilitation Associates"]);
    expect(mapNpiResult(REAL)!.aliases).toEqual([]);
  });
  it("aliases are stored on the organization", async () => {
    const a = await upsertLead(mapNpiResult(REAL2)!);
    expect((await queryOne<any>("SELECT aliases FROM organizations WHERE id = $1", [a.organizationId]))!.aliases).toEqual(["Texas Orthopedics, Sports & Rehabilitation Associates"]);
  });
  it("maps location, primary specialty and the authorized official", () => {
    const o = mapNpiResult(REAL)!;
    expect(o).toMatchObject({ name: "1960 Family Practice, PA", npi: "1184173221", specialty: "General Practice", city: "Spring", state: "TX", zip: "77386", phone: "281-586-3888", address: "3550 RAYFORD RD SUITE 110A" });
    expect(o.official).toEqual({ name: "Huong T. Le, MD", title: "Owner", phone: "281-586-3888", credential: "MD" });
  });
  it("official edge cases: placeholders, missing names, individuals", () => {
    expect(mapAuthorizedOfficial({})).toBeUndefined();
    expect(mapAuthorizedOfficial({ authorized_official_first_name: "ANA", authorized_official_last_name: "O'NEIL", authorized_official_middle_name: "--", authorized_official_credential: "--", authorized_official_title_or_position: "--", authorized_official_telephone_number: "" })).toEqual({ name: "Ana O'Neil", title: null, phone: null, credential: null });
    expect(mapNpiResult({ number: 1, enumeration_type: "NPI-1", basic: { first_name: "A", last_name: "B", authorized_official_first_name: "X", authorized_official_last_name: "Y" } })!.official).toBeUndefined();
  });
  it("primary-specialty matching: prefix, case-insensitive, spelling-tolerant", () => {
    expect(primaryMatches("Orthopaedic Surgery", "Orthopedic")).toBe(true);
    expect(primaryMatches("General Practice", "Orthopaedic")).toBe(false);
    expect(primaryMatches("Cardiovascular Disease", "cardio*")).toBe(true);
    expect(primaryMatches(null, "x")).toBe(false);
  });
  it("client filters secondary-taxonomy matches by default, reports the raw page size, and can opt out", async () => {
    const ortho = { ...REAL, number: "2", taxonomies: [{ desc: "Orthopaedic Surgery", primary: true }] };
    const f = (async () => new Response(JSON.stringify({ result_count: 2, results: [REAL, ortho] }))) as any;
    const c = new NppesClient(f);
    const pg = await c.searchPage({ state: "TX", taxonomy: "Orthopedic" });
    expect(pg.raw).toBe(2);
    expect(pg.items.map((i) => i.npi)).toEqual(["2"]);
    expect((await c.searchPage({ state: "TX", taxonomy: "Orthopedic", primaryOnly: false })).items).toHaveLength(2);
    expect((await c.search({ state: "TX", taxonomy: "Orthopedic" }))).toHaveLength(1);
  });
});

describe("official becomes a decision-maker contact", () => {
  it("is stored once, with phone and source, even if the org is discovered again", async () => {
    const o = mapNpiResult(REAL)!;
    const a = await upsertLead(o);
    await upsertLead(o);
    const cs = await getContacts(a.organizationId);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ full_name: "Huong T. Le, MD", title: "Owner", phone: "281-586-3888", is_decision_maker: true, source: "nppes", email: null });
  });

  it("discovery pages by RAW count even when filtering removes results, and stores officials", async () => {
    const mk = (n: number, primary: string) => ({ ...REAL, number: String(1000 + n), basic: { ...REAL.basic, organization_name: `CLINIC ${n}` }, taxonomies: [{ desc: primary, primary: true }] });
    const all = [mk(1, "Orthopaedic Surgery"), mk(2, "General Practice"), mk(3, "Orthopaedic Surgery"), mk(4, "Cardiology")];
    const calls: any[] = [];
    const client = new NppesClient((async (u: string) => { const sp = new URL(u).searchParams; calls.push([sp.get("skip"), sp.get("limit")]); const skip = Number(sp.get("skip") ?? 0), lim = Number(sp.get("limit")); return new Response(JSON.stringify({ results: all.slice(skip, skip + lim) })); }) as any);
    const run = await enqueueRun({ kind: "discover", input: { states: ["TX"], taxonomy: "Orthopedic", limit: 4 } });
    while (await processOne("t", makeDeps({ npi: client }))); // drains
    const r = (await getRun(run.id))!;
    expect(r.status, r.error ?? "").toBe("succeeded");
    expect(r.output).toMatchObject({ created: 2, fetched: 2 });
    expect((await query("SELECT name FROM organizations ORDER BY name")).map((x: any) => x.name)).toEqual(["Clinic 1", "Clinic 3"]);
    expect(await query("SELECT 1 FROM contacts WHERE source = 'nppes'")).toHaveLength(2);
    expect(calls).toEqual([[null, "4"]]); // raw page (4) satisfied the limit, no extra request
  });
});
