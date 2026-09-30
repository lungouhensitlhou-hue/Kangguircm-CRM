import { isValidEmail, normalizeEmail } from "../compliance";

export const EHR_VENDORS: [string, RegExp][] = [
  ["Epic", /\bepic (systems|mychart)|\bmychart\b/i],
  ["athenahealth", /athena\s?health|athenaone|athenanet/i],
  ["eClinicalWorks", /e\s?clinical\s?works|\beclinicalworks\b|\bhealow\b/i],
  ["NextGen", /\bnext\s?gen\b/i],
  ["ModMed", /\bmodmed\b|modernizing medicine|\bebosuite\b/i],
  ["Tebra / Kareo", /\btebra\b|\bkareo\b/i],
  ["AdvancedMD", /advanced\s?md/i],
  ["DrChrono", /dr\.?\s?chrono/i],
  ["Cerner / Oracle Health", /\bcerner\b|oracle health/i],
  ["Veradigm / Allscripts", /\ballscripts\b|\bveradigm\b/i],
  ["Greenway", /greenway (health|intergy|prime)/i],
  ["MEDITECH", /\bmeditech\b/i],
  ["CareCloud", /care\s?cloud/i],
  ["Elation", /elation health/i],
  ["Nextech", /\bnextech\b/i],
  ["WebPT", /\bwebpt\b/i],
  ["CureMD", /\bcure\s?md\b/i],
  ["Practice Fusion", /practice fusion/i],
  ["Amazing Charts", /amazing charts/i],
  ["ChiroTouch", /chirotouch/i],
];

export function detectEhr(text: string): string | null {
  for (const [name, re] of EHR_VENDORS) if (re.test(text)) return name;
  return null;
}

const JUNK_EMAIL = /(\.(png|jpe?g|gif|svg|webp|css|js)$)|(@2x)|example\.(com|org)|sentry|wixpress|godaddy|domain\.com|yourdomain|email\.com$/i;

export function extractEmails(text: string, extra: string[] = []): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) found.add(normalizeEmail(m[0]));
  for (const e of extra) found.add(normalizeEmail(e));
  return [...found].filter((e) => isValidEmail(e) && !JUNK_EMAIL.test(e));
}

const TITLE_RE = /(practice manager|office manager|clinic manager|business manager|billing manager|revenue cycle (manager|director)|director of (operations|finance|revenue cycle|billing)|administrator|practice administrator|chief (executive|operating|financial) officer|\bCEO\b|\bCOO\b|\bCFO\b|managing partner|owner|founder|president|medical director|operations manager|hospital administrator)/i;
const NAME_RE = /((?:Dr\.?\s+)?[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?(?:,?\s+(?:MD|DO|NP|PA-C|PA|RN|MBA|CPA|FACHE|DPM|DDS))*)/;
const NOT_NAMES = /^(our|the|meet|contact|about|office|practice|medical|billing|patient|health|clinic|director|manager|chief|executive|operations|primary|family|urgent|care|center|services|group)\b/i;

export interface Person { name: string; title: string }

/** Find "Name — Title" / "Name, Title" / two-line "Name\nTitle" patterns near leadership titles. */
export function extractPeople(text: string): Person[] {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: Person[] = [];
  const push = (name: string, title: string) => {
    const n = name.replace(/^Dr\.?\s+/, "Dr. ").trim();
    if (NOT_NAMES.test(n) || n.split(/\s+/).length < 2 || seen.has(n.toLowerCase())) return;
    seen.add(n.toLowerCase());
    out.push({ name: n, title: title.trim().slice(0, 80) });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 140) continue;
    const t = line.match(TITLE_RE);
    if (!t) continue;
    const before = line.slice(0, t.index).replace(/[\s,\-–—:|(]+$/, "");
    const after = line.slice((t.index ?? 0) + t[0].length).replace(/^[\s,\-–—:|)]+/, "");
    const titleText = line.slice(t.index).replace(/\s*[|–—-].*$/, "");
    const nm = before.match(new RegExp("^" + NAME_RE.source + "$")) ?? after.match(new RegExp("^" + NAME_RE.source));
    if (nm) { push(nm[1], titleText); continue; }
    // Two-line layout: name on the previous line, title here (or the reverse).
    const prev = lines[i - 1]?.match(new RegExp(NAME_RE.source + "$"));
    if (prev && line.length < 60) { push(prev[1], line); continue; }
    const next = lines[i + 1]?.match(new RegExp("^(?:Meet\\s+)?" + NAME_RE.source + "$"));
    if (next && line.length < 60) push(next[1], line);
  }
  return out.slice(0, 8);
}

export function estimateProviders(text: string): number {
  const names = new Set<string>();
  for (const m of text.matchAll(/\bDr\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g)) names.add(m[1].toLowerCase());
  for (const m of text.matchAll(/([A-Z][a-z]+\s+[A-Z][a-z]+),?\s+(?:MD|DO|NP|PA-C|DPM|FNP)\b/g)) names.add(m[1].toLowerCase());
  return names.size;
}

export interface PainSignal { signal: string; evidence: string }
const SIGNALS: [string, RegExp][] = [
  ["Hiring billing / coding staff", /(hiring|now hiring|join our team|open positions?|careers?)[\s\S]{0,300}(medical (biller|coder)|billing (specialist|coordinator|clerk)|coding specialist|revenue cycle|insurance (specialist|coordinator))/i],
  ["Prior-authorization workload", /prior[- ]?auth(orization)?s?/i],
  ["Multi-payer complexity (Medicare, Medicaid & commercial)", /(medicare)[\s\S]{0,200}(medicaid)|accept(s|ing)? (most|all|many) (major )?insurance/i],
  ["Multiple locations to bill across", /\b(\d+|two|three|four|five|six|multiple|several)\s+(convenient\s+)?locations\b/i],
  ["Patient billing / statements handled in-house", /(pay (your )?bill online|patient (portal|billing)|billing (questions|department|office))/i],
];
export function detectPainSignals(text: string): PainSignal[] {
  const out: PainSignal[] = [];
  for (const [signal, re] of SIGNALS) {
    const m = text.match(re);
    if (m) out.push({ signal, evidence: text.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + Math.min(m[0].length, 160) + 40).replace(/\s+/g, " ").trim() });
  }
  return out;
}

export function classifyDecisionMaker(title: string | null | undefined): boolean {
  return !!title && TITLE_RE.test(title);
}

/** Match a person to an email whose local part contains their first/last name (jane.smith@, jsmith@, smithj@). */
export function matchEmailToPerson(name: string, emails: string[]): string | null {
  const parts = name.toLowerCase().replace(/^dr\.?\s+/, "").replace(/[^a-z\s'-]/g, "").split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0], last = parts[parts.length - 1];
  const scored = emails
    .filter((e) => !/^(info|contact|office|admin|hello|support|billing|frontdesk|reception|appointments|scheduling)@/.test(e))
    .map((e) => {
      const local = e.split("@")[0].replace(/[^a-z]/g, "");
      let score = 0;
      if (last.length >= 3 && local.includes(last)) score += 2;
      if (first.length >= 3 && local.includes(first)) score += 2;
      if (local === first[0] + last || local === last + first[0]) score += 2;
      return { e, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.e ?? null;
}
