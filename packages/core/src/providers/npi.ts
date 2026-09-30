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
}

export interface NpiClient {
  search(q: NpiQuery): Promise<NewOrg[]>;
}

type Fetch = typeof fetch;
const tc = (s: string | undefined) =>
  (s ?? "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Llc|Llp|Pllc|Pc|Pa|Md|Dpm|Dds)\b/g, (m) => m.toUpperCase());

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
  };
}

export class NppesClient implements NpiClient {
  constructor(private fetchImpl: Fetch = fetch, private baseUrl = "https://npiregistry.cms.hhs.gov/api/") {}

  async search(q: NpiQuery): Promise<NewOrg[]> {
    const p = new URLSearchParams({ version: "2.1", enumeration_type: q.type ?? "NPI-2", limit: String(Math.min(q.limit ?? 50, 200)) });
    if (q.skip) p.set("skip", String(q.skip));
    if (q.state) p.set("state", q.state.toUpperCase());
    if (q.city) p.set("city", q.city);
    if (q.taxonomy) p.set("taxonomy_description", q.taxonomy);
    if (q.organizationName) p.set("organization_name", q.organizationName);
    if (!q.state && !q.city && !q.taxonomy && !q.organizationName) throw new Error("NPI search needs at least one filter (state, city, specialty or name)");
    const res = await this.fetchImpl(`${this.baseUrl}?${p}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`NPPES registry returned HTTP ${res.status}`);
    const body: any = await res.json();
    if (body?.Errors?.length) throw new Error(`NPPES: ${body.Errors.map((e: any) => e.description).join("; ")}`);
    return (body.results ?? []).map(mapNpiResult).filter(Boolean) as NewOrg[];
  }
}
