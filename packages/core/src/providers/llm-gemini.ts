import type { z } from "zod";
import { postJson, type PostOptions } from "./http";
import { runJson, type ChatTurn, type LLM, type ToolSpec, type Usage } from "./llm";

export interface GeminiConfig { apiKey: string; model: string; baseUrl?: string; http?: PostOptions }

/** Google Gemini via the Generative Language REST API (generateContent with function calling). */
export class GeminiLLM implements LLM {
  readonly name: string;
  readonly model: string;
  constructor(private cfg: GeminiConfig) {
    this.model = cfg.model;
    this.name = `gemini:${cfg.model}`;
  }

  private async generate(system: string, contents: any[], tools: ToolSpec[] | undefined, maxTokens: number) {
    const body: any = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: maxTokens } };
    if (tools?.length) {
      body.tools = [{
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          // Gemini rejects an OBJECT schema with no properties, so parameterless tools omit it.
          ...(Object.keys(t.input_schema.properties).length ? { parameters: t.input_schema } : {}),
        })),
      }];
    }
    const base = this.cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const res = await postJson(`${base}/models/${encodeURIComponent(this.cfg.model)}:generateContent`, { "x-goog-api-key": this.cfg.apiKey }, body, { label: "gemini", ...this.cfg.http });
    const j: any = await res.json();
    const cand = j.candidates?.[0];
    const usage: Usage = { tokensIn: j.usageMetadata?.promptTokenCount ?? 0, tokensOut: (j.usageMetadata?.candidatesTokenCount ?? 0) + (j.usageMetadata?.thoughtsTokenCount ?? 0) };
    if (!cand) throw new Error(`gemini: ${j.promptFeedback?.blockReason ? "prompt blocked (" + j.promptFeedback.blockReason + ")" : "empty response"}`);
    const parts: any[] = cand.content?.parts ?? [];
    return {
      text: parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join(""),
      calls: parts.filter((p) => p.functionCall).map((p) => p.functionCall as { name: string; args?: Record<string, unknown> }),
      raw: cand.content,
      blocked: cand.finishReason === "SAFETY" || cand.finishReason === "PROHIBITED_CONTENT",
      usage,
    };
  }

  private toContents(turns: ChatTurn[]) {
    return turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] }));
  }

  async json<T>(o: { system: string; prompt: string; schema: z.ZodType<T>; maxTokens?: number }) {
    return runJson({
      prompt: o.prompt,
      schema: o.schema,
      call: async (turns) => {
        const r = await this.generate(o.system, this.toContents(turns), undefined, o.maxTokens ?? 4000);
        if (r.blocked) throw new Error("model refused the request");
        return { text: r.text, usage: r.usage };
      },
    });
  }

  async converse(o: Parameters<LLM["converse"]>[0]) {
    const usage: Usage = { tokensIn: 0, tokensOut: 0 };
    const contents: any[] = this.toContents(o.messages);
    const max = o.maxSteps ?? 8;
    let steps = 0;
    for (; steps < max; steps++) {
      const r = await this.generate(o.system, contents, o.tools, o.maxTokens ?? 4000);
      usage.tokensIn += r.usage.tokensIn;
      usage.tokensOut += r.usage.tokensOut;
      if (!r.calls.length) {
        if (r.blocked) return { text: "I can't help with that request.", usage, steps: steps + 1 };
        return { text: r.text.trim(), usage, steps: steps + 1 };
      }
      contents.push(r.raw);
      const responses: any[] = [];
      for (const c of r.calls) {
        let result: unknown;
        try { result = { result: await o.onTool(c.name, c.args ?? {}) }; } catch (e) { result = { error: (e as Error).message }; }
        responses.push({ functionResponse: { name: c.name, response: result } });
      }
      contents.push({ role: "user", parts: responses });
    }
    return { text: "I reached my step limit before finishing. Progress so far is recorded in the run log.", usage, steps };
  }
}
