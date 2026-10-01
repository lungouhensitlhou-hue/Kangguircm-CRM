import type { Page, WebTools } from "../providers/web";
import { pickOfficialSite } from "../providers/web";
import type { Organization } from "../types";

const LEGAL = new Set(["llc", "pllc", "pc", "pa", "inc", "corp", "ltd", "llp", "lp", "co", "the", "of", "and", "at", "for", "dba"]);
const GENERIC = new Set(["associates", "group", "clinic", "center", "centre", "practice", "medical", "health", "healthcare", "care", "specialists", "physicians", "institute", "services", "partners"]);
const TLDS = ["com", "org", "net", "health", "md"];
const MAX_ATTEMPTS = 12;

const words = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

/** Likely domains for an organization, most probable first, capped. Pure. */
export function domainCandidates(names: string[], max = MAX_ATTEMPTS): string[] {
  const bases: string[] = [];
  for (const n of names) {
    const t = words(n).filter((w) => !LEGAL.has(w));
    if (!t.length) continue;
    const core = t.filter((w) => !GENERIC.has(w));
    for (const v of [t.join(""), core.join(""), t.slice(0, 2).join(""), core.slice(0, 2).join(""), core[0] ?? ""]) if (v.length >= 4 && !bases.includes(v)) bases.push(v);
  }
  const out: string[] = [];
  for (const b of bases) out.push(`${b}.com`);
  for (const tld of TLDS.slice(1)) for (const b of bases.slice(0, 2)) out.push(`${b}.${tld}`);
  return [...new Set(out)].slice(0, max);
}

const PARKED = /(domain (is )?(for sale|may be for sale)|buy this domain|this domain is parked|domain parking|coming soon|under construction|godaddy|sedo\.com|hugedomains)/i;
const MED = /(patients?|appointments?|physicians?|doctors?|clinic|medical|health|surgery|orthop|cardio|urgent care|insurance accepted)/gi;

export interface SiteScore { score: number; reasons: string[] }

/** How sure are we that this page is THIS practice's site? Name words, city, phone and healthcare vocabulary. Pure. */
export function scoreSite(page: Pick<Page, "title" | "text">, org: Pick<Organization, "name" | "city" | "state" | "phone"> & { aliases?: string[] }): SiteScore {
  const reasons: string[] = [];
  const hay = `${page.title}\n${page.text.slice(0, 6000)}`.toLowerCase();
  if (PARKED.test(hay) && hay.length < 3000) return { score: 0, reasons: ["parked or placeholder page"] };
  let score = 0;
  let best = 0;
  for (const n of [org.name, ...(org.aliases ?? [])]) {
    const t = words(n).filter((w) => !LEGAL.has(w) && !GENERIC.has(w));
    if (!t.length) continue;
    best = Math.max(best, t.filter((w) => hay.includes(w)).length / t.length);
  }
  if (best > 0) { score += Math.round(best * 45); reasons.push(`name words ${Math.round(best * 100)}%`); }
  if (org.city && hay.includes(org.city.toLowerCase())) { score += 15; reasons.push("city"); }
  if (org.state && new RegExp(`\\b${org.state.toLowerCase()}\\b`).test(hay)) { score += 5; reasons.push("state"); }
  const digits = (org.phone ?? "").replace(/\D/g, "").slice(-10);
  if (digits.length === 10) {
    const fmts = [`${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`, `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`, `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`, digits];
    if (fmts.some((f) => hay.includes(f))) { score += 35; reasons.push("phone number matches"); }
  }
  const med = Math.min(5, (hay.match(MED) ?? []).length) * 2;
  if (med) { score += med; reasons.push("healthcare vocabulary"); }
  return { score: Math.min(100, score), reasons };
}

export interface FoundSite { website: string; confidence: number; reasons: string[]; via: "search" | "guess" }
export const ACCEPT_SCORE = 60;

/** Accept only strong evidence: a phone match, or near-complete name coverage plus the city. */
function accepted(s: SiteScore): boolean {
  return s.score >= ACCEPT_SCORE && (s.reasons.some((r) => r.startsWith("phone")) || (s.reasons.some((r) => r === "city") && s.reasons.some((r) => /name words (8|9|10)\d?%|name words 100%/.test(r))));
}

export interface FindOptions { /** try guessed domains (default true) */ guess?: boolean; /** parallel fetches (default 4) */ concurrency?: number; /** stop starting new guesses after this many ms (default 30s) */ budgetMs?: number }

export async function findDomain(web: WebTools, org: Pick<Organization, "name" | "city" | "state" | "phone"> & { aliases?: string[] }, log?: (m: string) => Promise<void>, opts: FindOptions = {}): Promise<FoundSite | null> {
  const tried = new Set<string>();
  const check = async (origin: string, via: FoundSite["via"]): Promise<FoundSite | null> => {
    if (tried.has(origin)) return null;
    tried.add(origin);
    const page = await web.fetchPage(origin);
    if (!page) return null;
    const sc = scoreSite(page, org);
    await log?.(`${origin}: score ${sc.score} (${sc.reasons.join(", ") || "no signals"})`);
    return accepted(sc) ? { website: new URL(page.url).origin, confidence: sc.score, reasons: sc.reasons, via } : null;
  };
  // 1. A search provider is the best signal when configured.
  try {
    const hits = await web.search(`${org.name} ${org.city ?? ""} ${org.state ?? ""}`.trim());
    const top = pickOfficialSite(hits);
    if (top) { const f = await check(top, "search"); if (f) return f; }
  } catch { /* search is optional */ }
  // 2. Otherwise guess likely domains (in small parallel batches, within a time budget) and demand evidence on the page.
  if (opts.guess === false) return null;
  const started = Date.now();
  const cands = domainCandidates([org.name, ...(org.aliases ?? [])]);
  const n = opts.concurrency ?? 4;
  for (let i = 0; i < cands.length; i += n) {
    if (Date.now() - started > (opts.budgetMs ?? 30_000)) { await log?.("Domain guessing stopped: time budget used"); break; }
    const batch = await Promise.all(cands.slice(i, i + n).map((d) => check(`https://${d}`, "guess").catch(() => null)));
    const hit = batch.find(Boolean); // batch order = likelihood order
    if (hit) return hit;
  }
  return null;
}
