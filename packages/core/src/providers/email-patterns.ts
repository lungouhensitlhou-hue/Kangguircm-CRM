export type Pattern = "first.last" | "firstlast" | "flast" | "first" | "last" | "firstl" | "f.last" | "first_last" | "last.first" | "lastf";

/** General US business prior, most common first. Learned per-domain patterns always outrank these. */
export const PRIORS: Pattern[] = ["first.last", "flast", "first", "firstlast", "firstl", "last", "f.last", "last.first", "first_last", "lastf"];

const SUFFIX = /^(jr|sr|ii|iii|iv|md|do|np|pa|pac|rn|dds|dpm|phd|mba|cpa|fnp|dc|od|facs)\.?$/i;
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

/** "Dr. Huong T. Le, MD" → {first:"huong", last:"le"}. Null when there is no usable first+last. */
export function parseName(full: string | null | undefined): { first: string; last: string } | null {
  if (!full) return null;
  const cleaned = full.replace(/\(.*?\)/g, " ").replace(/,.*$/, " ").replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, "");
  const tokens = cleaned.split(/\s+/).filter(Boolean).filter((t) => !SUFFIX.test(t)).filter((t) => fold(t).length > 1 || !/^[A-Za-z]\.?$/.test(t));
  if (tokens.length < 2) return null;
  const first = fold(tokens[0]), last = fold(tokens[tokens.length - 1]);
  return first && last ? { first, last } : null;
}

export function render(p: Pattern, n: { first: string; last: string }): string {
  const f = n.first, l = n.last;
  switch (p) {
    case "first.last": return `${f}.${l}`;
    case "firstlast": return `${f}${l}`;
    case "flast": return `${f[0]}${l}`;
    case "first": return f;
    case "last": return l;
    case "firstl": return `${f}${l[0]}`;
    case "f.last": return `${f[0]}.${l}`;
    case "first_last": return `${f}_${l}`;
    case "last.first": return `${l}.${f}`;
    case "lastf": return `${l}${f[0]}`;
  }
}

/** Candidate addresses for a person at a domain, learned patterns first, then the priors. Deduplicated. */
export function candidates(name: string, domain: string, learned: Pattern[] = []): { email: string; pattern: Pattern; learned: boolean }[] {
  const n = parseName(name);
  if (!n) return [];
  const seen = new Set<string>();
  const out: { email: string; pattern: Pattern; learned: boolean }[] = [];
  for (const p of [...learned, ...PRIORS]) {
    const email = `${render(p, n)}@${domain.toLowerCase()}`;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ email, pattern: p, learned: learned.includes(p) });
  }
  return out;
}

/** Which pattern produced this address for this person? (first match in priority order) */
export function inferPattern(email: string, name: string): Pattern | null {
  const n = parseName(name);
  const local = email.split("@")[0]?.toLowerCase();
  if (!n || !local) return null;
  return PRIORS.find((p) => render(p, n) === local) ?? null;
}

/** Rank patterns by how many known (name, email) pairs follow them. */
export function learnFromPairs(pairs: { name: string; email: string }[]): Pattern[] {
  const count = new Map<Pattern, number>();
  for (const { name, email } of pairs) { const p = inferPattern(email, name); if (p) count.set(p, (count.get(p) ?? 0) + 1); }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || PRIORS.indexOf(a[0]) - PRIORS.indexOf(b[0])).map(([p]) => p);
}
