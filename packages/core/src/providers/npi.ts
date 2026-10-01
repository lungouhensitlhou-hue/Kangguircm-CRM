import type { NewOrg } from "../leads";

export interface NpiQuery {
  state?: string;
  city?: string;
  /** e.g. "Orthopedic", matched against taxonomy description (NPPES supports prefix/wildcard). */
  taxonomy?: string;
  organizationName?: string;
  /** NPI-2 = organizations/facilities (default), NPI-1 = individual providers. */
  type?: "NPI-1" | "NPI-2";
  limit?: number;
  skip?: number;
  /**
   * The registry matches the specialty against ANY of an organization's taxonomies, so a "General Practice" group that lists
   * Orthopaedic Surgery as a secondary taxonomy matches an orthopaedic search. Default true: keep only primary-taxonomy matches.
   */
  primaryOnly?: boolean;
}

export interface NpiPage { items: NewOrg[]; /** records returned by the registry before filtering (for paging) */ raw: number }

export interface NpiClient {
  search(q: NpiQuery): Promise<NewOrg[]>;
  /** Like search, but also reports the raw page size so callers can page correctly when results are filtered. */
  searchPage?(q: NpiQuery): Promise<NpiPage>;
}

type Fetch = typeof fetch;
const tc = (s: string | undefined) =>
  (s ?? "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Llc|Llp|Pllc|Pc|Pa|Md|Dpm|Dds)\b/g, (m) => m.toUpperCase());

/** Title-case a job title but keep acronyms (CEO, COO, MD...) upper-case. */
const tcTitle = (s: string) => tc(s).replace(/\b(Ceo|Coo|Cfo|Cmo|Cio|Cto|Md|Do|Rn|Np|Pa|Dpm|Dds|Ii|Iii)\b/g, (m) => m.toUpperCase());

const fmtPhone = (p?: string | null) => { const d = (p ?? "").replace(/\D/g, ""); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : (p ?? "") || null; };

/** NPI-2 records carry an "authorized official": a named owner/officer with title and phone. Free, authoritative decision-maker data. */
export function mapAuthorizedOfficial(basic: any): NewOrg["official"] | undefined {
  const first = String(basic?.authorized_official_first_name ?? "").trim();
  const last = String(basic?.authorized_official_last_name ?? "").trim();
  if (!first || !last) return undefined;
  const mid = String(basic?.authorized_official_middle_name ?? "").trim();
  const cred = String(basic?.authorized_official_credential ?? "").replace(/[^A-Za-z.,\- ]/g, "").trim();
  const name = [tc(first), mid && mid !== "--" ? (mid.length === 1 ? `${mid.toUpperCase()}.` : tc(mid)) : "", tc(last)].filter(Boolean).join(" ") + (cred && cred !== "--" ? `, ${cred.toUpperCase()}` : "");
  const title = tcTitle(String(basic?.authorized_official_title_or_position ?? "").trim());
  return { name, title: title && title !== "--" ? title : null, phone: fmtPhone(basic?.authorized_official_telephone_number), credential: cred && cred !== "--" ? cred.toUpperCase() : null };
}

/** Map one NPPES registry record to a lead-ready organization. Exported for tests. */
export function mapNpiResult(r: any): NewOrg | null {
  const basic = r?.basic ?? {};
  const isOrg = r?.enumeration_type === "NPI-2";
  const name = isOrg
    ? tc(basic.organization_name)
    : tc([basic.first_name, basic.last_name].filter(Boolean).join(" ")) + (basic.credential ? `, ${basic.credential}` : "");
  if (!name.trim()) return null;
  const addr = (r.addresses ?? []).find((a: any) => a.address_purpose === "LOCATION") ?? r.addresses?.[0] ?? {};
  const tax = (r.taxonomies ?? []).find((t: any) => t.primary) ?? r.taxonomies?.[0] ?? {};
  return {
    name,
    npi: String(r.number),
    entity_type: isOrg ? "organization" : "individual",
    specialty: tax.desc ?? null,
    address: [addr.address_1, addr.address_2].filter(Boolean).join(" ") || null,
    city: tc(addr.city) || null,
    state: addr.state ?? null,
    zip: (addr.postal_code ?? "").slice(0, 5) || null,
    phone: addr.telephone_number ?? null,
    source: "nppes",
    official: isOrg ? mapAuthorizedOfficial(basic) : undefined,
    aliases: (r.other_names ?? []).map((n: any) => tc(String(n.organization_name ?? "")).trim()).filter((n: string) => n && n.toLowerCase() !== name.toLowerCase()),
  };
}

/** Does the org's PRIMARY specialty match what was asked for (trailing wildcard = prefix match, case-insensitive)? */
export function primaryMatches(specialty: string | null | undefined, requested: string): boolean {
  const want = normalizeTaxonomy(requested).replace(/\*$/, "").toLowerCase();
  return (specialty ?? "").toLowerCase().startsWith(want);
}

/** The registry spells it "Orthopaedic" and supports trailing wildcards; make friendly input match. */
export function normalizeTaxonomy(t: string): string {
  let v = t.trim().replace(/orthoped/i, "Orthopaed");
  if (v.length >= 2 && !v.includes("*")) v += "*";
  return v;
}

export class NppesClient implements NpiClient {
  constructor(private fetchImpl: Fetch = fetch, private baseUrl = "https://npiregistry.cms.hhs.gov/api/") {}

  async search(q: NpiQuery): Promise<NewOrg[]> {
    return (await this.searchPage(q)).items;
  }

  async searchPage(q: NpiQuery): Promise<NpiPage> {
    // The registry rejects a state-only search ("requires additional search criteria") and caps skip at 1000.
    if (!q.taxonomy && !q.city && !q.organizationName) throw new Error("NPI search needs a specialty, city or name in addition to state (the registry does not allow state-only searches)");
    if ((q.skip ?? 0) > 1000) throw new Error("NPPES registry limits paging to the first 1,200 results per query; narrow the search (city or specialty)");
    const p = new URLSearchParams({ version: "2.1", enumeration_type: q.type ?? "NPI-2", limit: String(Math.min(q.limit ?? 50, 200)) });
    if (q.skip) p.set("skip", String(q.skip));
    if (q.state) p.set("state", q.state.toUpperCase());
    if (q.city) p.set("city", q.city);
    if (q.taxonomy) p.set("taxonomy_description", normalizeTaxonomy(q.taxonomy));
    if (q.organizationName) p.set("organization_name", q.organizationName);
    const res = await this.fetchImpl(`${this.baseUrl}?${p}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`NPPES registry returned HTTP ${res.status}`);
    const body: any = await res.json();
    if (body?.Errors?.length) throw new Error(`NPPES: ${body.Errors.map((e: any) => e.description).join("; ")}`);
    const all = (body.results ?? []).map(mapNpiResult).filter(Boolean) as NewOrg[];
    const items = q.taxonomy && q.primaryOnly !== false ? all.filter((o) => primaryMatches(o.specialty, q.taxonomy!)) : all;
    return { items, raw: (body.results ?? []).length };
  }
}
