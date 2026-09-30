export interface PostOptions {
  fetchImpl?: typeof fetch;
  /** Delays between retries on 429/5xx/network errors. [] = no retry. */
  retryDelaysMs?: number[];
  timeoutMs?: number;
  label?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST with bounded retry on rate limits / server errors. Returns the raw Response (2xx) or throws with the provider's message. */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, o: PostOptions = {}): Promise<Response> {
  const f = o.fetchImpl ?? fetch;
  const delays = o.retryDelaysMs ?? [800, 2500];
  const label = o.label ?? new URL(url).host;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
      });
      if (res.ok) return res;
      const text = (await res.text().catch(() => "")).slice(0, 400);
      lastErr = new Error(`${label} API error ${res.status}: ${text}`);
      if (res.status !== 429 && res.status < 500) throw Object.assign(lastErr, { fatal: true });
    } catch (e) {
      if ((e as any).fatal) throw e;
      lastErr = e as Error;
    }
    if (attempt < delays.length) await sleep(delays[attempt]);
  }
  throw lastErr ?? new Error(`${label} request failed`);
}
