import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAICompatLLM } from "../src/providers/llm-openai";
import { GeminiLLM } from "../src/providers/llm-gemini";
import { OPENAI_COMPAT_PRESETS, detectLlmProvider, llmFromEnv } from "../src/providers/llm-factory";
import { AnthropicLLM, costUsd } from "../src/providers/llm";
import { braveSearcher, detectSearchProvider, searcherFromEnv, serpApiSearcher, serperSearcher, tavilySearcher } from "../src/providers/search";
import { MailgunMailer, PostmarkMailer, ResendMailer, SendGridMailer, DryRunMailer, SmtpMailer, detectEmailProvider, mailerFromEnv } from "../src/providers/mailer";
import { postJson } from "../src/providers/http";
import { integrationStatus } from "../src/providers/integrations";

/** Scripted fetch: returns queued responses in order and records every request. */
function mockFetch(responses: (Response | (() => Response))[]) {
  const calls: { url: string; init: any; body: any }[] = [];
  const f = (async (url: string, init: any) => {
    let body: any = init?.body;
    try { body = typeof body === "string" ? JSON.parse(body) : body; } catch { /* form / plain */ }
    calls.push({ url: String(url), init, body });
    const r = responses.shift();
    if (!r) throw new Error("no scripted response");
    return typeof r === "function" ? r() : r;
  }) as unknown as typeof fetch;
  return { f, calls };
}
const j = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const NO_WAIT = { retryDelaysMs: [1, 1] };

describe("postJson", () => {
  it("retries 429/5xx then succeeds; never retries 4xx", async () => {
    const m = mockFetch([j({}, 429), j({}, 503), j({ ok: 1 })]);
    const res = await postJson("https://x.test/a", {}, {}, { fetchImpl: m.f, ...NO_WAIT });
    expect(await res.json()).toEqual({ ok: 1 });
    expect(m.calls).toHaveLength(3);
    const m2 = mockFetch([j({ error: "bad key" }, 401), j({ ok: 1 })]);
    await expect(postJson("https://x.test/a", {}, {}, { fetchImpl: m2.f, ...NO_WAIT, label: "acme" })).rejects.toThrow(/acme API error 401.*bad key/);
    expect(m2.calls).toHaveLength(1);
    const m3 = mockFetch([j({}, 500), j({}, 500), j({}, 500)]);
    await expect(postJson("https://x.test/a", {}, {}, { fetchImpl: m3.f, ...NO_WAIT })).rejects.toThrow(/500/);
    expect(m3.calls).toHaveLength(3);
  });
});

describe("OpenAI-compatible LLM", () => {
  const cfg = (fetchImpl: typeof fetch, over: any = {}) => ({ provider: "openai", apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", model: "gpt-x", http: { fetchImpl, ...NO_WAIT }, ...over });

  it("json(): builds the request, parses output, repairs once, reports usage", async () => {
    const m = mockFetch([
      j({ choices: [{ message: { content: 'Sure: ```json\n{"a":"x"}\n```' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
      j({ choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
    ]);
    const llm = new OpenAICompatLLM(cfg(m.f, { tokenParam: "max_completion_tokens" }));
    const r = await llm.json({ system: "SYS", prompt: "P", schema: z.object({ a: z.number() }), maxTokens: 999 });
    expect(r.data).toEqual({ a: 1 });
    expect(r.usage).toEqual({ tokensIn: 22, tokensOut: 7 });
    const c = m.calls[0];
    expect(c.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(c.init.headers.authorization).toBe("Bearer sk-test");
    expect(c.body.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(c.body.max_completion_tokens).toBe(999);
    expect(c.body.max_tokens).toBeUndefined();
    expect(c.body.tools).toBeUndefined();
    expect(m.calls[1].body.messages.at(-1).content).toContain("invalid");
  });

  it("uses max_tokens by default and omits auth for keyless local servers", async () => {
    const m = mockFetch([j({ choices: [{ message: { content: "{}" } }] })]);
    const llm = new OpenAICompatLLM({ provider: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.1", http: { fetchImpl: m.f } });
    await llm.json({ system: "s", prompt: "p", schema: z.object({}) });
    expect(m.calls[0].body.max_tokens).toBeDefined();
    expect(m.calls[0].init.headers.authorization).toBeUndefined();
  });

  it("converse(): full tool loop with tool_calls, tool role replies, and bad-args/tool errors reported to the model", async () => {
    const m = mockFetch([
      j({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
        { id: "c1", type: "function", function: { name: "search_leads", arguments: '{"q":"ortho"}' } },
        { id: "c2", type: "function", function: { name: "boom", arguments: "{not json" } },
      ] } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }),
      j({ choices: [{ finish_reason: "stop", message: { content: "Found it." } }], usage: { prompt_tokens: 80, completion_tokens: 5 } }),
    ]);
    const llm = new OpenAICompatLLM(cfg(m.f));
    const seen: any[] = [];
    const tools = [{ name: "search_leads", description: "d", input_schema: { type: "object" as const, properties: { q: { type: "string" } } } }];
    const r = await llm.converse({ system: "S", messages: [{ role: "user", content: "hi" }], tools, onTool: async (n, i) => { seen.push([n, i]); return '{"n":2}'; } });
    expect(r.text).toBe("Found it.");
    expect(r.steps).toBe(2);
    expect(r.usage).toEqual({ tokensIn: 130, tokensOut: 15 });
    expect(seen).toEqual([["search_leads", { q: "ortho" }]]);
    expect(m.calls[0].body.tools[0]).toEqual({ type: "function", function: { name: "search_leads", description: "d", parameters: tools[0].input_schema } });
    const second = m.calls[1].body.messages;
    expect(second.find((x: any) => x.role === "assistant").tool_calls).toHaveLength(2);
    const toolMsgs = second.filter((x: any) => x.role === "tool");
    expect(toolMsgs[0]).toEqual({ role: "tool", tool_call_id: "c1", content: '{"n":2}' });
    expect(toolMsgs[1].tool_call_id).toBe("c2");
    expect(toolMsgs[1].content).toMatch(/^Error:/);
  });

  it("converse(): step limit stops runaway loops", async () => {
    const loop = () => j({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "c", function: { name: "a", arguments: "{}" } }] } }] });
    const m = mockFetch(Array.from({ length: 6 }, () => loop));
    const r = await new OpenAICompatLLM(cfg(m.f)).converse({ system: "s", messages: [{ role: "user", content: "x" }], tools: [], onTool: async () => "{}", maxSteps: 3 });
    expect(m.calls).toHaveLength(3);
    expect(r.text).toMatch(/step limit/);
  });

  it("surfaces API errors with the provider name", async () => {
    const m = mockFetch([j({ error: { message: "invalid api key" } }, 401)]);
    await expect(new OpenAICompatLLM(cfg(m.f, { provider: "groq" })).json({ system: "s", prompt: "p", schema: z.object({}) })).rejects.toThrow(/groq API error 401.*invalid api key/);
  });
});

describe("Gemini LLM", () => {
  const G = (f: typeof fetch) => new GeminiLLM({ apiKey: "gk", model: "gemini-x", http: { fetchImpl: f, ...NO_WAIT } });
  it("json(): systemInstruction, key header, role mapping, token accounting", async () => {
    const m = mockFetch([j({ candidates: [{ content: { parts: [{ text: '{"a":2}' }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2 } })]);
    const r = await G(m.f).json({ system: "SYS", prompt: "P", schema: z.object({ a: z.number() }) });
    expect(r.data).toEqual({ a: 2 });
    expect(r.usage).toEqual({ tokensIn: 7, tokensOut: 5 });
    const c = m.calls[0];
    expect(c.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
    expect(c.init.headers["x-goog-api-key"]).toBe("gk");
    expect(c.body.systemInstruction.parts[0].text).toBe("SYS");
    expect(c.body.contents[0].role).toBe("user");
    expect(c.body.tools).toBeUndefined();
  });
  it("converse(): functionCall/functionResponse loop; parameterless tools omit schema", async () => {
    const m = mockFetch([
      j({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "pipeline_stats", args: {} } }, { functionCall: { name: "search_leads", args: { q: "x" } } }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } }),
      j({ candidates: [{ content: { role: "model", parts: [{ text: "You have 3 leads." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 6 } }),
    ]);
    const tools = [
      { name: "pipeline_stats", description: "d", input_schema: { type: "object" as const, properties: {} } },
      { name: "search_leads", description: "d", input_schema: { type: "object" as const, properties: { q: { type: "string" } } } },
    ];
    const r = await G(m.f).converse({ system: "S", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "user", content: "stats?" }], tools, onTool: async (n) => { if (n === "search_leads") throw new Error("nope"); return "{\"total\":3}"; } });
    expect(r.text).toBe("You have 3 leads.");
    expect(r.usage).toEqual({ tokensIn: 60, tokensOut: 11 });
    const decl = m.calls[0].body.tools[0].functionDeclarations;
    expect(decl[0].parameters).toBeUndefined();
    expect(decl[1].parameters.properties.q).toBeDefined();
    expect(m.calls[0].body.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
    const last = m.calls[1].body.contents.at(-1);
    expect(last.role).toBe("user");
    expect(last.parts[0].functionResponse).toEqual({ name: "pipeline_stats", response: { result: '{"total":3}' } });
    expect(last.parts[1].functionResponse).toEqual({ name: "search_leads", response: { error: "nope" } });
  });
  it("reports blocked prompts", async () => {
    const m = mockFetch([j({ promptFeedback: { blockReason: "SAFETY" } })]);
    await expect(G(m.f).json({ system: "s", prompt: "p", schema: z.object({}) })).rejects.toThrow(/blocked/);
  });
});

describe("LLM provider selection from env", () => {
  it("returns null with no keys, or when AGENT_LLM=off", () => {
    expect(llmFromEnv({})).toBeNull();
    expect(llmFromEnv({ OPENAI_API_KEY: "k", AGENT_LLM: "off" })).toBeNull();
  });
  it("auto-detects by key, with Anthropic > Gemini > others precedence", () => {
    expect(detectLlmProvider({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" })).toBe("anthropic");
    expect(detectLlmProvider({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" })).toBe("gemini");
    expect(detectLlmProvider({ GOOGLE_API_KEY: "g" })).toBe("gemini");
    expect(detectLlmProvider({ GROQ_API_KEY: "g" })).toBe("groq");
    expect(detectLlmProvider({ OPENROUTER_API_KEY: "k" })).toBe("openrouter");
    expect(detectLlmProvider({ LLM_BASE_URL: "http://x/v1" })).toBe("custom");
    expect(detectLlmProvider({ LLM_PROVIDER: "OpenAI", ANTHROPIC_API_KEY: "a" })).toBe("openai");
    expect(detectLlmProvider({ LLM_PROVIDER: "google" })).toBe("gemini");
  });
  it("builds every preset with the right endpoint/model, and honors AGENT_MODEL", () => {
    for (const [name, p] of Object.entries(OPENAI_COMPAT_PRESETS)) {
      if (name === "custom") continue;
      const llm = llmFromEnv({ LLM_PROVIDER: name, LLM_API_KEY: "k" }) as any;
      expect(llm.name).toBe(`${name}:${p.model}`);
      expect(llm.cfg.baseUrl).toBe(p.baseUrl);
    }
    expect((llmFromEnv({ OPENAI_API_KEY: "k", AGENT_MODEL: "gpt-custom" }) as any).model).toBe("gpt-custom");
    expect((llmFromEnv({ GEMINI_API_KEY: "k" }) as any).name).toBe("gemini:gemini-2.0-flash");
    expect(llmFromEnv({ ANTHROPIC_API_KEY: "k" })).toBeInstanceOf(AnthropicLLM);
    const custom = llmFromEnv({ LLM_PROVIDER: "custom", LLM_BASE_URL: "https://my.host/v1/", AGENT_MODEL: "m1", LLM_API_KEY: "k" }) as any;
    expect(custom.cfg.baseUrl).toBe("https://my.host/v1");
  });
  it("gives clear errors for misconfiguration", () => {
    expect(() => llmFromEnv({ LLM_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
    expect(() => llmFromEnv({ LLM_PROVIDER: "nonsense", LLM_API_KEY: "k" })).toThrow(/Unknown LLM_PROVIDER.*Supported/);
    expect(() => llmFromEnv({ LLM_PROVIDER: "custom", LLM_BASE_URL: "http://x/v1" })).toThrow(/AGENT_MODEL/);
    expect(() => llmFromEnv({ LLM_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
    expect(() => llmFromEnv({ LLM_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
  });
  it("cost tracking: known Claude prices, env prices for others, zero when unknown", () => {
    expect(costUsd("claude-opus-5-5", { tokensIn: 1e6, tokensOut: 0 }, {})).toBe(4);
    expect(costUsd("gpt-x", { tokensIn: 2e6, tokensOut: 1e6 }, { LLM_PRICE_IN: "2.5", LLM_PRICE_OUT: "10" })).toBe(15);
    expect(costUsd("gpt-x", { tokensIn: 2e6, tokensOut: 1e6 }, {})).toBe(0);
  });
});

describe("web search providers", () => {
  it("brave / tavily / serper / serpapi request + response mapping", async () => {
    let m = mockFetch([j({ web: { results: [{ title: "T", url: "https://a.test", description: "D" }] } })]);
    expect(await braveSearcher("bk", { fetchImpl: m.f })("q x")).toEqual([{ title: "T", url: "https://a.test", snippet: "D" }]);
    expect(m.calls[0].url).toContain("q=q%20x");
    expect(m.calls[0].init.headers["x-subscription-token"]).toBe("bk");

    m = mockFetch([j({ results: [{ title: "T", url: "https://b.test", content: "C" }] })]);
    expect(await tavilySearcher("tk", { fetchImpl: m.f })("q")).toEqual([{ title: "T", url: "https://b.test", snippet: "C" }]);
    expect(m.calls[0].init.headers.authorization).toBe("Bearer tk");
    expect(m.calls[0].body.query).toBe("q");

    m = mockFetch([j({ organic: [{ title: "T", link: "https://c.test", snippet: "S" }] })]);
    expect(await serperSearcher("sk", { fetchImpl: m.f })("q")).toEqual([{ title: "T", url: "https://c.test", snippet: "S" }]);
    expect(m.calls[0].init.headers["x-api-key"]).toBe("sk");

    m = mockFetch([j({ organic_results: [{ title: "T", link: "https://d.test", snippet: "S" }] })]);
    expect(await serpApiSearcher("ak", { fetchImpl: m.f })("q")).toEqual([{ title: "T", url: "https://d.test", snippet: "S" }]);
    expect(m.calls[0].url).toContain("api_key=ak");
  });
  it("selection from env", () => {
    expect(detectSearchProvider({})).toBeNull();
    expect(detectSearchProvider({ TAVILY_API_KEY: "k" })).toBe("tavily");
    expect(detectSearchProvider({ BRAVE_API_KEY: "k", TAVILY_API_KEY: "k" })).toBe("brave");
    expect(detectSearchProvider({ BRAVE_API_KEY: "k", SEARCH_PROVIDER: "off" })).toBeNull();
    expect(searcherFromEnv({})).toBeNull();
    expect(() => searcherFromEnv({ SEARCH_PROVIDER: "serper" })).toThrow(/SERPER_API_KEY/);
    expect(() => searcherFromEnv({ SEARCH_PROVIDER: "bing", BING_API_KEY: "x" })).toThrow(/Unknown SEARCH_PROVIDER/);
    expect(typeof searcherFromEnv({ SERPER_API_KEY: "k" })).toBe("function");
  });
});

describe("email providers", () => {
  const mail = { to: "jane@practice.test", from: "Sam Rivers <sam@kangguircm.test>", subject: "Hello", text: "Body", headers: { "List-Unsubscribe": "<https://app/u/1>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, idempotencyKey: "msg-1" };

  it("Resend", async () => {
    const m = mockFetch([j({ id: "re_123" })]);
    expect(await new ResendMailer("rk", { fetchImpl: m.f, retryDelaysMs: [] }).send(mail)).toEqual({ id: "re_123" });
    const c = m.calls[0];
    expect(c.url).toBe("https://api.resend.com/emails");
    expect(c.init.headers.authorization).toBe("Bearer rk");
    expect(c.init.headers["idempotency-key"]).toBe("msg-1");
    expect(c.body).toMatchObject({ from: mail.from, to: [mail.to], subject: "Hello", text: "Body", headers: mail.headers });
  });
  it("SendGrid (splits name/address, disables tracking, id from header)", async () => {
    const m = mockFetch([new Response(null, { status: 202, headers: { "x-message-id": "sg-9" } })]);
    expect(await new SendGridMailer("sk", { fetchImpl: m.f, retryDelaysMs: [] }).send(mail)).toEqual({ id: "sg-9" });
    const b = m.calls[0].body;
    expect(b.from).toEqual({ email: "sam@kangguircm.test", name: "Sam Rivers" });
    expect(b.personalizations[0].to[0].email).toBe(mail.to);
    expect(b.content[0]).toEqual({ type: "text/plain", value: "Body" });
    expect(b.tracking_settings.click_tracking.enable).toBe(false);
    expect(b.headers["List-Unsubscribe-Post"]).toBeDefined();
  });
  it("Postmark", async () => {
    const m = mockFetch([j({ MessageID: "pm-1" })]);
    expect(await new PostmarkMailer("pt", "outbound", { fetchImpl: m.f, retryDelaysMs: [] }).send(mail)).toEqual({ id: "pm-1" });
    expect(m.calls[0].init.headers["x-postmark-server-token"]).toBe("pt");
    expect(m.calls[0].body.Headers).toContainEqual({ Name: "List-Unsubscribe", Value: "<https://app/u/1>" });
    expect(m.calls[0].body.TrackOpens).toBe(false);
  });
  it("Mailgun (form-encoded, basic auth, EU region)", async () => {
    const m = mockFetch([j({ id: "<mg@x>" })]);
    expect(await new MailgunMailer("mk", "mg.kangguircm.test", "eu", m.f).send(mail)).toEqual({ id: "<mg@x>" });
    const c = m.calls[0];
    expect(c.url).toBe("https://api.eu.mailgun.net/v3/mg.kangguircm.test/messages");
    expect(c.init.headers.authorization).toBe(`Basic ${Buffer.from("api:mk").toString("base64")}`);
    const form = new URLSearchParams(c.init.body);
    expect(form.get("to")).toBe(mail.to);
    expect(form.get("h:List-Unsubscribe")).toBe("<https://app/u/1>");
    const bad = mockFetch([new Response("Forbidden", { status: 403 })]);
    await expect(new MailgunMailer("mk", "d", "us", bad.f).send(mail)).rejects.toThrow(/mailgun API error 403/);
  });
  it("providers surface failures (so the queue can retry) and never retry inside the call", async () => {
    const m = mockFetch([j({ message: "domain not verified" }, 422), j({ id: "x" })]);
    await expect(new ResendMailer("rk", { fetchImpl: m.f, retryDelaysMs: [] }).send(mail)).rejects.toThrow(/resend API error 422.*domain not verified/);
    expect(m.calls).toHaveLength(1);
  });
  it("selection from env", () => {
    expect(detectEmailProvider({})).toBe("dry-run");
    expect(mailerFromEnv({})).toBeInstanceOf(DryRunMailer);
    expect(detectEmailProvider({ SMTP_URL: "smtp://x" })).toBe("smtp");
    expect(detectEmailProvider({ SMTP_URL: "smtp://x", SENDGRID_API_KEY: "k" })).toBe("sendgrid");
    expect(detectEmailProvider({ MAILGUN_API_KEY: "k" })).toBe("dry-run"); // needs a domain too
    expect(detectEmailProvider({ MAILGUN_API_KEY: "k", MAILGUN_DOMAIN: "d" })).toBe("mailgun");
    expect(detectEmailProvider({ POSTMARK_SERVER_TOKEN: "t" })).toBe("postmark");
    expect(mailerFromEnv({ RESEND_API_KEY: "k" }).name).toBe("resend");
    expect(mailerFromEnv({ SMTP_URL: "smtp://u:p@localhost:2525" })).toBeInstanceOf(SmtpMailer);
    expect(() => mailerFromEnv({ EMAIL_PROVIDER: "sendgrid" })).toThrow(/SENDGRID_API_KEY/);
    expect(() => mailerFromEnv({ EMAIL_PROVIDER: "carrier-pigeon" })).toThrow(/Unknown EMAIL_PROVIDER/);
  });
  it("integrationStatus summarizes the environment", () => {
    expect(integrationStatus({})).toEqual({ llm: null, email: "dry-run", search: null, inbound: false, deliversEmail: false });
    expect(integrationStatus({ GROQ_API_KEY: "k", RESEND_API_KEY: "k", TAVILY_API_KEY: "k", INBOUND_WEBHOOK_SECRET: "s" })).toEqual({ llm: "groq", email: "resend", search: "tavily", inbound: true, deliversEmail: true });
  });
});
