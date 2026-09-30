import type { z } from "zod";
import { postJson, type PostOptions } from "./http";
import { runJson, type ChatTurn, type LLM, type ToolSpec, type Usage } from "./llm";

export interface OpenAICompatConfig {
  /** Display name, e.g. "openai", "groq". */
  provider: string;
  apiKey?: string;
  /** e.g. https://api.openai.com/v1 (no trailing slash). */
  baseUrl: string;
  model: string;
  /** Official OpenAI models require max_completion_tokens; most compatible servers still use max_tokens. */
  tokenParam?: "max_tokens" | "max_completion_tokens";
  extraHeaders?: Record<string, string>;
  http?: PostOptions;
}

/**
 * Speaks the Chat Completions wire format used by OpenAI and the many services that copy it
 * (Groq, Together, Mistral, DeepSeek, xAI, OpenRouter, Ollama, vLLM, LM Studio, Azure-style gateways...).
 */
export class OpenAICompatLLM implements LLM {
  readonly name: string;
  readonly model: string;
  constructor(private cfg: OpenAICompatConfig) {
    this.model = cfg.model;
    this.name = `${cfg.provider}:${cfg.model}`;
  }

  private async chat(system: string, messages: any[], tools: ToolSpec[] | undefined, maxTokens: number) {
    const body: any = {
      model: this.cfg.model,
      messages: [{ role: "system", content: system }, ...messages],
      [this.cfg.tokenParam ?? "max_tokens"]: maxTokens,
    };
    if (tools?.length) {
      body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
      body.tool_choice = "auto";
    }
    const headers: Record<string, string> = { ...(this.cfg.extraHeaders ?? {}) };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const res = await postJson(`${this.cfg.baseUrl}/chat/completions`, headers, body, { label: this.cfg.provider, ...this.cfg.http });
    const j: any = await res.json();
    const choice = j.choices?.[0];
    if (!choice) throw new Error(`${this.cfg.provider}: empty response`);
    const usage: Usage = { tokensIn: j.usage?.prompt_tokens ?? 0, tokensOut: j.usage?.completion_tokens ?? 0 };
    return { message: choice.message ?? {}, finish: choice.finish_reason as string | undefined, usage };
  }

  async json<T>(o: { system: string; prompt: string; schema: z.ZodType<T>; maxTokens?: number }) {
    return runJson({
      prompt: o.prompt,
      schema: o.schema,
      call: async (turns: ChatTurn[]) => {
        const r = await this.chat(o.system, turns, undefined, o.maxTokens ?? 4000);
        if (r.finish === "content_filter") throw new Error("model refused the request");
        return { text: typeof r.message.content === "string" ? r.message.content : "", usage: r.usage };
      },
    });
  }

  async converse(o: Parameters<LLM["converse"]>[0]) {
    const usage: Usage = { tokensIn: 0, tokensOut: 0 };
    const messages: any[] = o.messages.map((m) => ({ role: m.role, content: m.content }));
    const max = o.maxSteps ?? 8;
    let steps = 0;
    for (; steps < max; steps++) {
      const r = await this.chat(o.system, messages, o.tools, o.maxTokens ?? 4000);
      usage.tokensIn += r.usage.tokensIn;
      usage.tokensOut += r.usage.tokensOut;
      const calls: any[] = r.message.tool_calls ?? [];
      if (!calls.length) {
        if (r.finish === "content_filter") return { text: "I can't help with that request.", usage, steps: steps + 1 };
        return { text: String(r.message.content ?? "").trim(), usage, steps: steps + 1 };
      }
      messages.push({ role: "assistant", content: r.message.content ?? null, tool_calls: calls });
      for (const c of calls) {
        let content: string;
        try {
          const args = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
          content = await o.onTool(c.function.name, args);
        } catch (e) {
          content = `Error: ${(e as Error).message}`;
        }
        messages.push({ role: "tool", tool_call_id: c.id, content });
      }
    }
    return { text: "I reached my step limit before finishing. Progress so far is recorded in the run log.", usage, steps };
  }
}
