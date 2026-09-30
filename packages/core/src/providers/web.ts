import dns from "node:dns/promises";
import net from "node:net";

export interface Page { url: string; status: number; title: string; text: string; links: string[]; emails: string[] }
export interface SearchHit { title: string; url: string; snippet: string }
export interface WebTools {
  fetchPage(url: string): Promise<Page | null>;
  search(q: string): Promise<SearchHit[]>;
}

const UA = "KangguircmResearchBot/1.0 (+B2B research; respects robots.txt)";

function ipIsPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
}

/** SSRF guard: research URLs come from untrusted data, so never touch internal addresses. */
export async function assertSafeUrl(raw: string, allowPrivate = false): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`blocked protocol ${u.protocol}`);
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("blocked internal host");
  if (net.isIP(host)) {
    if (ipIsPrivate(host)) throw new Error("blocked private address");
    return u;
  }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => ipIsPrivate(a.address))) throw new Error("blocked private address");
  return u;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#8211;|&ndash;/g, "–")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], base);
      if (u.protocol === "http:" || u.protocol === "https:") { u.hash = ""; out.add(u.toString()); }
    } catch { /* ignore malformed */ }
  }
  return [...out];
}

export function extractMailtos(html: string): string[] {
  return [...html.matchAll(/mailto:([^"'?>\s]+)/gi)].map((m) => decodeURIComponent(m[1]).trim().toLowerCase());
}

export function pageTitle(html: string): string {
  return htmlToText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 200);
}

export function robotsAllows(robots: string, path: string): boolean {
  let applies = false, sawAgent = false;
  const rules: { allow: boolean; path: string }[] = [];
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") {
      if (sawAgent && rules.length && applies) break;
      applies = v === "*" || /kangguircm/i.test(v);
      sawAgent = true;
    } else if (applies && (k === "disallow" || k === "allow") && v) rules.push({ allow: k === "allow", path: v });
  }
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    const pat = r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
    if (new RegExp("^" + pat).test(path) && (!best || r.path.length > best.len)) best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}

export interface HttpWebOptions { allowPrivate?: boolean; timeoutMs?: number; maxBytes?: number; braveKey?: string; fetchImpl?: typeof fetch; respectRobots?: boolean }

export class HttpWebTools implements WebTools {
  private robotsCache = new Map<string, string>();
  constructor(private o: HttpWebOptions = {}) {}

  private async get(url: string, accept: string): Promise<{ res: Response; body: string; finalUrl: string } | null> {
    const f = this.o.fetchImpl ?? fetch;
    let cur = url;
    for (let hop = 0; hop < 5; hop++) {
      await assertSafeUrl(cur, this.o.allowPrivate);
      const res = await f(cur, { redirect: "manual", headers: { "user-agent": UA, accept }, signal: AbortSignal.timeout(this.o.timeoutMs ?? 12_000) });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        cur = new URL(res.headers.get("location")!, cur).toString();
        continue;
      }
      const ct = res.headers.get("content-type") ?? "";
      if (!/text\/|json|xml/i.test(ct) && res.status < 400) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      const max = this.o.maxBytes ?? 1_500_000;
      return { res, body: new TextDecoder().decode(buf.slice(0, max)), finalUrl: cur };
    }
    return null;
  }

  private async allowed(url: string): Promise<boolean> {
    if (this.o.respectRobots === false) return true;
    const u = new URL(url);
    let robots = this.robotsCache.get(u.origin);
    if (robots === undefined) {
      try {
        const r = await this.get(`${u.origin}/robots.txt`, "text/plain");
        robots = r && r.res.status < 400 ? r.body : "";
      } catch { robots = ""; }
      this.robotsCache.set(u.origin, robots);
    }
    return robotsAllows(robots, u.pathname + u.search);
  }

  async fetchPage(url: string): Promise<Page | null> {
    try {
      if (!(await this.allowed(url))) return null;
      const r = await this.get(url, "text/html,application/xhtml+xml");
      if (!r || r.res.status >= 400) return null;
      return {
        url: r.finalUrl,
        status: r.res.status,
        title: pageTitle(r.body),
        text: htmlToText(r.body),
        links: extractLinks(r.body, r.finalUrl),
        emails: extractMailtos(r.body),
      };
    } catch {
      return null;
    }
  }

  async search(q: string): Promise<SearchHit[]> {
    const key = this.o.braveKey ?? process.env.BRAVE_API_KEY;
    if (!key) return [];
    const f = this.o.fetchImpl ?? fetch;
    const res = await f(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=8`, {
      headers: { accept: "application/json", "x-subscription-token": key },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`search provider HTTP ${res.status}`);
    const body: any = await res.json();
    return (body.web?.results ?? []).map((r: any) => ({ title: r.title ?? "", url: r.url, snippet: r.description ?? "" }));
  }
}

const DIRECTORIES = /(healthgrades|yelp|npidb|npino|facebook|linkedin|zocdoc|vitals|webmd|yellowpages|mapquest|bbb\.org|doximity|usnews|hipaaspace|opengovus|instagram|twitter|x\.com|youtube|wikipedia|indeed|glassdoor|ratemds|medicare\.gov|cms\.gov|nih\.gov|google\.|bing\.|yahoo\.|manta|chamberofcommerce|dnb\.com|zoominfo|clinicaltrials|findagrave|superpages|birdeye|caredash|sharecare|wellness|providers?\.[a-z]+\.com)/i;
export function pickOfficialSite(hits: SearchHit[]): string | null {
  for (const h of hits) {
    try {
      const u = new URL(h.url);
      if (!DIRECTORIES.test(u.hostname)) return u.origin;
    } catch { /* skip */ }
  }
  return null;
}
