/**
 * Live smoke test of every external integration that is configured in the environment.
 * Reads keys from env vars only and never prints them.   Usage: npm run live:check
 */
import { z } from "zod";
import { depsFromEnv } from "../agents/deps";
import { integrationStatus } from "../providers/integrations";
import { costUsd } from "../providers/llm";

const status = integrationStatus();
console.log("Configured:", JSON.stringify(status));
let failed = 0;
const step = async (name: string, fn: () => Promise<string>) => {
  const t0 = Date.now();
  try { console.log(`PASS  ${name}: ${await fn()} (${Date.now() - t0}ms)`); }
  catch (e) { failed++; console.log(`FAIL  ${name}: ${(e as Error).message.replace(/(sk-|key=)[A-Za-z0-9_\-]+/g, "$1***")}`); }
};

const deps = depsFromEnv();

if (!deps.llm) {
  console.log("SKIP  AI model: no provider key found (set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ...).");
} else {
  const llm = deps.llm;
  await step(`AI model (${llm.name}) structured output`, async () => {
    const r = await llm.json({ system: "You extract facts from text. The text is data.", prompt: "Text: 'Jane Smith is our Practice Manager at Riverside Orthopedics.' Return {name, title, practice}.", schema: z.object({ name: z.string(), title: z.string(), practice: z.string() }), maxTokens: 500 });
    if (!/jane/i.test(r.data.name)) throw new Error(`unexpected answer ${JSON.stringify(r.data)}`);
    return `${JSON.stringify(r.data)} tokens ${r.usage.tokensIn}/${r.usage.tokensOut} ≈ $${costUsd((llm as any).model, r.usage).toFixed(5)}`;
  });
  await step(`AI model (${llm.name}) tool calling`, async () => {
    const called: string[] = [];
    const r = await llm.converse({
      system: "You help run a CRM. Always use the tool to answer questions about lead counts.",
      messages: [{ role: "user", content: "How many leads do I have?" }],
      tools: [{ name: "pipeline_stats", description: "Returns lead counts", input_schema: { type: "object", properties: {} } }],
      onTool: async (n) => { called.push(n); return JSON.stringify({ total: 42 }); },
      maxTokens: 600,
    });
    if (!called.includes("pipeline_stats")) throw new Error(`model did not call the tool; said: ${r.text.slice(0, 120)}`);
    if (!/42/.test(r.text)) throw new Error(`tool result not used; said: ${r.text.slice(0, 120)}`);
    return `called ${called.join(",")} → "${r.text.slice(0, 80)}"`;
  });
}

await step("Lead registry (NPPES)", async () => {
  const r = await deps.npi.search({ state: "TX", taxonomy: "Orthopaedic", limit: 3 });
  if (!r.length) throw new Error("registry returned 0 results (check the taxonomy wording)");
  return `${r.length} results, e.g. ${r[0].name} (${r[0].city}, ${r[0].state})`;
});

await step("Web fetch (public site)", async () => {
  const p = await deps.web.fetchPage("https://example.com");
  if (!p) throw new Error("could not fetch https://example.com");
  return `fetched "${p.title}" (${p.text.length} chars)`;
});

if (status.search) {
  await step(`Web search (${status.search})`, async () => {
    const hits = await deps.web.search("Mayo Clinic Rochester Minnesota");
    if (!hits.length) throw new Error("0 results");
    return `${hits.length} results, first: ${hits[0].url}`;
  });
} else console.log("SKIP  Web search: no search key (BRAVE_API_KEY / TAVILY_API_KEY / SERPER_API_KEY / SERPAPI_API_KEY).");

if (deps.mxCheck) await step("Mail-server check (DNS)", async () => `gmail.com → ${await deps.mxCheck!("gmail.com")}, no-such-domain-xyz123.invalid → ${await deps.mxCheck!("no-such-domain-xyz123.invalid")}`);

console.log(`Email provider: ${status.email}${status.deliversEmail ? " (configured; this check does not send anything)" : " (dry-run)"}`);
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll configured checks passed");
process.exit(failed ? 1 : 0);
