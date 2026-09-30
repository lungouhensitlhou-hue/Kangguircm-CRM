import { postJson, type PostOptions } from "./http";
import type { SearchHit } from "./web";

type Env = Record<string, string | undefined>;
export type Searcher = (q: string) => Promise<SearchHit[]>;

export function braveSearcher(key: string, http: PostOptions = {}): Searcher {
  return async (q) => {
    const f = http.fetchImpl ?? fetch;
    const res = await f(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=8`, {
      headers: { accept: "application/json", "x-subscription-token": key }, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`brave API error ${res.status}`);
    const b: any = await res.json();
    return (b.web?.results ?? []).map((r: any) => ({ title: r.title ?? "", url: r.url, snippet: r.description ?? "" }));
  };
}

export function tavilySearcher(key: string, http: PostOptions = {}): Searcher {
  return async (q) => {
    const res = await postJson("https://api.tavily.com/search", { authorization: `Bearer ${key}` }, { query: q, max_results: 8, search_depth: "basic" }, { label: "tavily", ...http });
    const b: any = await res.json();
    return (b.results ?? []).map((r: any) => ({ title: r.title ?? "", url: r.url, snippet: r.content ?? "" }));
  };
}

export function serperSearcher(key: string, http: PostOptions = {}): Searcher {
  return async (q) => {
    const res = await postJson("https://google.serper.dev/search", { "x-api-key": key }, { q, num: 8, gl: "us" }, { label: "serper", ...http });
    const b: any = await res.json();
    return (b.organic ?? []).map((r: any) => ({ title: r.title ?? "", url: r.link, snippet: r.snippet ?? "" }));
  };
}

export function serpApiSearcher(key: string, http: PostOptions = {}): Searcher {
  return async (q) => {
    const f = http.fetchImpl ?? fetch;
    const res = await f(`https://serpapi.com/search.json?engine=google&num=8&gl=us&q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`serpapi API error ${res.status}`);
    const b: any = await res.json();
    return (b.organic_results ?? []).map((r: any) => ({ title: r.title ?? "", url: r.link, snippet: r.snippet ?? "" }));
  };
}

const CANDIDATES: [string, string, (k: string, h?: PostOptions) => Searcher][] = [
  ["brave", "BRAVE_API_KEY", braveSearcher],
  ["tavily", "TAVILY_API_KEY", tavilySearcher],
  ["serper", "SERPER_API_KEY", serperSearcher],
  ["serpapi", "SERPAPI_API_KEY", serpApiSearcher],
];
export const SUPPORTED_SEARCH_PROVIDERS = CANDIDATES.map((c) => c[0]);

export function detectSearchProvider(env: Env = process.env): string | null {
  const explicit = env.SEARCH_PROVIDER?.trim().toLowerCase();
  if (explicit === "off") return null;
  if (explicit) return explicit;
  return CANDIDATES.find(([, k]) => env[k]?.trim())?.[0] ?? null;
}

export function searcherFromEnv(env: Env = process.env, http: PostOptions = {}): Searcher | null {
  const name = detectSearchProvider(env);
  if (!name) return null;
  const c = CANDIDATES.find(([n]) => n === name);
  if (!c) throw new Error(`Unknown SEARCH_PROVIDER "${name}". Supported: ${SUPPORTED_SEARCH_PROVIDERS.join(", ")}`);
  const key = env[c[1]]?.trim();
  if (!key) throw new Error(`SEARCH_PROVIDER=${name} needs ${c[1]}`);
  return c[2](key, http);
}
