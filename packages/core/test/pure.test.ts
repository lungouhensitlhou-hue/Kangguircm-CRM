import { describe, expect, it } from "vitest";
import { complianceFooter, assembleBody, hasUnsubscribeIntent, isGenericMailbox, isValidEmail, isWithinSendWindow, nextSendWindow, senderReady } from "../src/compliance";
import { scoreLead } from "../src/scoring";
import { parseCsv, normalizeWebsite } from "../src/leads";
import { detectEhr, detectPainSignals, estimateProviders, extractEmails, extractPeople } from "../src/agents/heuristics";
import { extractJsonObject } from "../src/providers/llm";
import { mapNpiResult, NppesClient } from "../src/providers/npi";
import { assertSafeUrl, htmlToText, pickOfficialSite, robotsAllows } from "../src/providers/web";
import { DEFAULT_SETTINGS } from "../src/settings";
import { templateDraft, validateDraft, firstName } from "../src/agents/outreach";
import { groundExtraction } from "../src/agents/research";

const S = { ...DEFAULT_SETTINGS, senderEmail: "a@b.co", physicalAddress: "1 Main St, Austin TX 78701" };

describe("email + compliance", () => {
  it("validates emails", () => {
    expect(isValidEmail("jane@practice.com")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail(null)).toBe(false);
  });
  it("detects generic mailboxes", () => {
    expect(isGenericMailbox("info@x.com")).toBe(true);
    expect(isGenericMailbox("jane@x.com")).toBe(false);
  });
  it("footer has identity, address and unsubscribe link; body assembly is idempotent", () => {
    const f = complianceFooter(S, "tok123");
    expect(f).toContain(S.senderName);
    expect(f).toContain("1 Main St");
    expect(f).toContain("/unsubscribe/tok123");
    const once = assembleBody("Hello there", S, "tok123");
    expect(assembleBody(once, S, "tok123")).toBe(once);
  });
  it("flags missing sender identity", () => {
    expect(senderReady({ ...S, physicalAddress: "" }).missing).toContain("physical mailing address");
    expect(senderReady(S).ok).toBe(true);
  });
  it("detects opt-out language", () => {
    expect(hasUnsubscribeIntent("Please remove me from your list")).toBe(true);
    expect(hasUnsubscribeIntent("Stop emailing us")).toBe(true);
    expect(hasUnsubscribeIntent("Sounds interesting, call me Tuesday")).toBe(false);
  });
  it("send window honors timezone and weekends", () => {
    const w = { timezone: "America/New_York", sendWindowStartHour: 8, sendWindowEndHour: 17 };
    expect(isWithinSendWindow(new Date("2026-09-30T15:00:00Z"), w)).toBe(true); // Wed 11:00 ET
    expect(isWithinSendWindow(new Date("2026-09-30T03:00:00Z"), w)).toBe(false); // Tue 23:00 ET
    expect(isWithinSendWindow(new Date("2026-10-03T15:00:00Z"), w)).toBe(false); // Saturday
    const next = nextSendWindow(new Date("2026-10-03T15:00:00Z"), w);
    expect(isWithinSendWindow(next, w)).toBe(true);
    expect(next.getTime()).toBeGreaterThan(new Date("2026-10-03T15:00:00Z").getTime());
  });
});

describe("scoring", () => {
  it("rewards fit and reachable decision makers, capped 0-100", () => {
    const hi = scoreLead({ org: { specialty: "Orthopedic Surgery", ehr: "athenahealth", size_estimate: "~12 providers", website: "https://x.com", entity_type: "organization" }, hasDecisionMakerEmail: true, hasAnyContact: true, confidence: 0.8, painPoints: 3 });
    const lo = scoreLead({ org: { specialty: null, ehr: null, size_estimate: null, website: null, entity_type: "individual" }, hasDecisionMakerEmail: false, hasAnyContact: false });
    expect(hi.score).toBeGreaterThan(80);
    expect(hi.score).toBeLessThanOrEqual(100);
    expect(lo.score).toBeLessThan(20);
    expect(hi.reasons.length).toBeGreaterThan(3);
  });
});

describe("csv + urls", () => {
  it("parses quotes, commas, CRLF and BOM", () => {
    const rows = parseCsv('﻿Name,City,State\r\n"Smith, Jones & Co",Austin,TX\r\n"Line ""quoted""",Dallas,TX\r\n');
    expect(rows).toEqual([{ name: "Smith, Jones & Co", city: "Austin", state: "TX" }, { name: 'Line "quoted"', city: "Dallas", state: "TX" }]);
  });
  it("normalizes websites", () => {
    expect(normalizeWebsite("Example.com/about")).toBe("https://example.com");
    expect(normalizeWebsite("not a url")).toBeNull();
    expect(normalizeWebsite("")).toBeNull();
  });
});

describe("heuristics", () => {
  const text = "Meet Jane Smith\nPractice Manager\nRobert Alvarez, Billing Manager\nDr. Alan Weber - Medical Director\nContact: jane@ortho.test, info@ortho.test, logo@2x.png, test@example.com. We use athenahealth. Dr. Alan Weber, Dr. Priya Nair, Lee Cho, MD.";
  it("finds people with titles", () => {
    const p = extractPeople(text);
    const names = p.map((x) => x.name);
    expect(names).toContain("Jane Smith");
    expect(names).toContain("Robert Alvarez");
    expect(p.find((x) => x.name === "Jane Smith")!.title).toMatch(/practice manager/i);
  });
  it("finds real emails and filters junk", () => {
    expect(extractEmails(text)).toEqual(["jane@ortho.test", "info@ortho.test"]);
  });
  it("detects EHR, provider count and pain signals", () => {
    expect(detectEhr(text)).toBe("athenahealth");
    expect(estimateProviders(text)).toBe(3);
    const sig = detectPainSignals("We are now hiring! Open position: medical biller. Prior authorization required. Three convenient locations.");
    expect(sig.map((s) => s.signal)).toEqual(expect.arrayContaining(["Hiring billing / coding staff", "Prior-authorization workload", "Multiple locations to bill across"]));
  });
});

describe("llm helpers", () => {
  it("extracts JSON from fenced and chatty output", () => {
    expect(extractJsonObject('Sure!\n```json\n{"a":{"b":"}"},"c":[1]}\n```')).toEqual({ a: { b: "}" }, c: [1] });
    expect(() => extractJsonObject("no json")).toThrow();
  });
  it("grounding removes hallucinated people, emails and evidence", () => {
    const corpus = "Jane Smith is our Practice Manager. Email jane@x.test. We are hiring a medical biller today.";
    const out = groundExtraction({
      summary: "s", ehr: "Epic", size_estimate: null, specialties: [], confidence: 0.9,
      pain_points: [{ point: "hiring", evidence: "we are hiring a medical biller" }, { point: "made up", evidence: "we lose millions every year" }],
      decision_makers: [{ name: "Jane Smith", title: "Practice Manager", email: "jane@x.test" }, { name: "Bob Ghost", title: "CEO", email: "bob@x.test" }, { name: "Jane Smith", title: "PM", email: "fake@x.test" }],
    }, corpus);
    expect(out.decision_makers.map((d) => d.name)).toEqual(["Jane Smith", "Jane Smith"]);
    expect(out.decision_makers[0].email).toBe("jane@x.test");
    expect(out.decision_makers[1].email).toBeNull();
    expect(out.pain_points).toHaveLength(1);
    expect(out.ehr).toBeNull();
  });
});

describe("outreach drafting", () => {
  const facts = { org: { name: "Riverside Orthopedics", specialty: "Orthopedic Surgery", city: "Austin", state: "TX" }, contact: { full_name: "Dr. Jane Smith", title: "Practice Manager" }, ehr: "athenahealth", size: null, painPoints: [{ point: "Hiring billing / coding staff" }], summary: "", step: 1, previous: [] };
  it("template drafts pass validation and personalise", () => {
    const d = templateDraft(facts, S);
    expect(validateDraft(d)).toEqual([]);
    expect(d.body).toContain("Hi Jane,");
    expect(d.body).toContain("hiring");
    const f2 = templateDraft({ ...facts, step: 2, previous: [{ subject: "Billing support for Riverside Orthopedics", body: "x" }] }, S);
    expect(f2.subject.startsWith("Re: ")).toBe(true);
    expect(validateDraft(f2)).toEqual([]);
  });
  it("rejects placeholders, links, guarantees and own unsubscribe text", () => {
    const ok = "Hi Jane, I noticed your practice is hiring billers and wanted to introduce our team. We help orthopedic practices reduce denials and shorten days in A/R. Would a quick call be useful next week? Thanks, Sam";
    expect(validateDraft({ subject: "Hello", body: ok })).toEqual([]);
    expect(validateDraft({ subject: "Hello", body: ok + " [Name]" })).toContain("contains a placeholder");
    expect(validateDraft({ subject: "Hello", body: ok + " We guarantee results." })).toContain("contains risky/spammy claims");
    expect(validateDraft({ subject: "Hello", body: ok + " See https://x.com" })).toContain("must not include links");
    expect(validateDraft({ subject: "Hello", body: ok + " Unsubscribe below" })).toContain("must not include its own unsubscribe text");
  });
  it("firstName strips honorifics", () => { expect(firstName("Dr. Jane Smith")).toBe("Jane"); expect(firstName(null)).toBeNull(); });
});

describe("NPPES mapping", () => {
  it("maps an organization record", () => {
    const o = mapNpiResult({
      number: 1234567890, enumeration_type: "NPI-2", basic: { organization_name: "RIVERSIDE ORTHOPEDIC ASSOCIATES LLC" },
      addresses: [{ address_purpose: "MAILING", address_1: "PO BOX 1", city: "AUSTIN", state: "TX", postal_code: "787010001" }, { address_purpose: "LOCATION", address_1: "100 MAIN ST", city: "AUSTIN", state: "TX", postal_code: "787010001", telephone_number: "512-555-0100" }],
      taxonomies: [{ desc: "Orthopaedic Surgery", primary: true }],
    })!;
    expect(o).toMatchObject({ name: "Riverside Orthopedic Associates LLC".replace("Orthopedic", "Orthopedic"), npi: "1234567890", specialty: "Orthopaedic Surgery", city: "Austin", state: "TX", zip: "78701", phone: "512-555-0100", entity_type: "organization" });
  });
  it("client builds the query and surfaces registry errors", async () => {
    let url = "";
    const ok = new NppesClient((async (u: string) => { url = u; return new Response(JSON.stringify({ result_count: 0, results: [] })); }) as any);
    await ok.search({ state: "tx", taxonomy: "Orthopedic", limit: 500 });
    expect(url).toContain("state=TX");
    expect(url).toContain("taxonomy_description=Orthopedic");
    expect(url).toContain("limit=200");
    expect(url).toContain("enumeration_type=NPI-2");
    await expect(ok.search({})).rejects.toThrow(/at least one filter/);
    const bad = new NppesClient((async () => new Response(JSON.stringify({ Errors: [{ description: "Invalid state" }] }))) as any);
    await expect(bad.search({ state: "ZZ" })).rejects.toThrow(/Invalid state/);
    const http500 = new NppesClient((async () => new Response("x", { status: 503 })) as any);
    await expect(http500.search({ state: "TX" })).rejects.toThrow(/503/);
  });
});

describe("web safety", () => {
  it("blocks internal targets (SSRF)", async () => {
    for (const u of ["http://127.0.0.1/", "http://localhost:8080/", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data", "http://192.168.1.1/", "http://[::1]/", "file:///etc/passwd", "ftp://x.com/"]) {
      await expect(assertSafeUrl(u)).rejects.toThrow();
    }
    await expect(assertSafeUrl("http://127.0.0.1/", true)).resolves.toBeInstanceOf(URL);
  });
  it("robots.txt rules", () => {
    const r = "User-agent: *\nDisallow: /private\nAllow: /private/public\n";
    expect(robotsAllows(r, "/about")).toBe(true);
    expect(robotsAllows(r, "/private/x")).toBe(false);
    expect(robotsAllows(r, "/private/public/page")).toBe(true);
    expect(robotsAllows("", "/anything")).toBe(true);
  });
  it("html to text drops scripts/styles and decodes entities", () => {
    expect(htmlToText("<style>x{}</style><script>alert(1)</script><p>A &amp; B</p><p>C</p>")).toBe("A & B\nC");
  });
  it("picks official site over directories", () => {
    expect(pickOfficialSite([{ title: "", url: "https://www.healthgrades.com/x", snippet: "" }, { title: "", url: "https://riverside-ortho.com/about", snippet: "" }])).toBe("https://riverside-ortho.com");
    expect(pickOfficialSite([{ title: "", url: "https://yelp.com/biz/x", snippet: "" }])).toBeNull();
  });
});
