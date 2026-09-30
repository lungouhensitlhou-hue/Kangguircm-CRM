import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { query, queryOne } from "../src/db";
import { enqueueRun, getRun } from "../src/queue";
import { processOne } from "../src/agents/worker";
import { getContacts, getLead, upsertLead } from "../src/leads";
import { postChatMessage } from "../src/agents/chat";
import { llmFromEnv } from "../src/providers/llm-factory";
import { PAGES, makeDeps, readySettings, resetDb, setupDb, startSite, teardownDb } from "./helpers";
import { startFakeOpenAI } from "./fake-openai.mjs";

beforeAll(async () => { process.env.LLM_PRICE_IN = "1"; process.env.LLM_PRICE_OUT = "2"; await setupDb(); });
beforeEach(resetDb);
afterAll(teardownDb);

let site: Awaited<ReturnType<typeof startSite>>;
let ai: Awaited<ReturnType<typeof startFakeOpenAI>>;
beforeAll(async () => { site = await startSite(PAGES); ai = await startFakeOpenAI(); });
afterAll(async () => { await site.close(); await ai.close(); });

async function drain(deps: any) { while (await processOne("t", deps)); }

/** Real HTTP round-trips through the OpenAI-compatible adapter, selected purely by env vars like production. */
describe("non-Claude provider, real HTTP wire", () => {
  const env = () => ({ LLM_PROVIDER: "custom", LLM_BASE_URL: ai.url, AGENT_MODEL: "fake-model", LLM_API_KEY: "fake-key", LLM_PRICE_IN: "1", LLM_PRICE_OUT: "2" });

  it("research + outreach + chat all run on the configured provider", async () => {
    await readySettings();
    const llm = llmFromEnv(env())!;
    expect(llm.name).toBe("custom:fake-model");
    const deps = makeDeps({ llm });

    const { leadId } = await upsertLead({ name: "Riverside Orthopedics", specialty: "Orthopedic Surgery", city: "Austin", state: "TX", website: site.url });
    const r = await enqueueRun({ kind: "research", leadId, input: { thenOutreach: true } });
    await drain(deps);

    const profile = await queryOne<any>("SELECT * FROM research_profiles WHERE lead_id = $1", [leadId]);
    expect(profile.method).toBe("llm");
    expect(profile.summary).toContain("AI-extracted");
    expect(profile.decision_makers.map((d: any) => d.name)).toEqual(["Jane Smith"]); // "Ghost Person" hallucination dropped
    const contacts = await getContacts((await getLead(leadId))!.organization_id);
    expect(contacts.some((c) => c.email === "ghost@nowhere.test")).toBe(false);
    // the model gave no email for Jane, so it was linked from the address actually published on the page
    expect(contacts.find((c) => c.email === "jane.smith@riverside-ortho.test")).toMatchObject({ full_name: "Jane Smith", is_decision_maker: true });
    const draft = await queryOne<any>("SELECT * FROM messages WHERE lead_id = $1", [leadId]);
    expect(draft.subject).toBe("AI drafted: billing help");
    expect(draft.status).toBe("draft");
    expect(draft.body).toContain("/unsubscribe/");

    const run = (await getRun(r.id))!;
    expect(run.tokens_in).toBe(120);
    expect(Number(run.cost_usd)).toBeCloseTo((120 * 1 + 40 * 2) / 1e6, 7);

    const { runId } = await postChatMessage("t", "How is my pipeline?");
    await drain(deps);
    expect((await getRun(runId))!.status).toBe("succeeded");
    expect((await queryOne<any>("SELECT content FROM chat_messages WHERE run_id = $1", [runId]))!.content).toBe("AI summary: 1 leads in your pipeline.");

    // every request carried the key and the standard wire shape
    expect(ai.requests.every((q) => q.auth === "Bearer fake-key")).toBe(true);
    expect(ai.requests.some((q) => q.body.tools?.[0]?.function?.name === "search_leads")).toBe(true);
    expect(ai.requests.some((q) => q.body.messages.some((m: any) => m.role === "tool"))).toBe(true);
  });

  it("a wrong key fails cleanly and agents fall back to rules instead of crashing", async () => {
    await readySettings();
    const llm = llmFromEnv({ ...env(), LLM_API_KEY: "wrong" })!;
    (llm as any).cfg.http = { retryDelaysMs: [] };
    const { leadId } = await upsertLead({ name: "Riverside Orthopedics", city: "Austin", state: "TX", website: site.url });
    await enqueueRun({ kind: "research", leadId });
    await drain(makeDeps({ llm }));
    expect((await queryOne<any>("SELECT method FROM research_profiles"))!.method).toBe("heuristic");
    expect((await query("SELECT 1 FROM agent_events WHERE message LIKE '%bad key%'")).length).toBeGreaterThanOrEqual(1); // extraction and deep-research both reported it
    expect((await getLead(leadId))!.stage).toBe("researched");
  });
});
