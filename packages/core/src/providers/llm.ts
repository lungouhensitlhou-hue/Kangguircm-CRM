import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

export interface Usage { tokensIn: number; tokensOut: number }
export interface ToolSpec { name: string; description: string; input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] } }
export interface ChatTurn { role: "user" | "assistant"; content: string }

export interface LLM {
  readonly name: string;
  /** Ask for a JSON object and validate it against a zod schema (one repair retry). */
  json<T>(o: { system: string; prompt: string; schema: z.ZodType<T>; maxTokens?: number }): Promise<{ data: T; usage: Usage }>;
  /** Tool-use conversation. `onTool` executes a tool call and returns its textual result. */
  converse(o: {
    system: string;
    messages: ChatTurn[];
    tools: ToolSpec[];
    onTool: (name: string, input: any) => Promise<string>;
    maxSteps?: number;
    maxTokens?: number;
  }): Promise<{ text: string; usage: Usage; steps: number }>;
}

/** USD per million tokens (input, output). Used for run cost accounting only. */
const PRICING: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-fable-5-1": [10, 50],
  "claude-haiku-4-5": [1, 5],
};
export function costUsd(model: string, u: Usage): number {
  const [i, o] = PRICING[model] ?? [5, 25];
  return (u.tokensIn * i + u.tokensOut * o) / 1_000_000;
}

/** Pull the first balanced top-level JSON object out of free text (handles ```json fences and preamble). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("no JSON object found in model output");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object in model output");
}

type ClientLike = Pick<Anthropic, "messages">;

export class AnthropicLLM implements LLM {
  readonly name: string;
  constructor(private client: ClientLike, readonly model: string) {
    this.name = `anthropic:${model}`;
  }

  private text(content: Anthropic.ContentBlock[]): string {
    return content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  }

  async json<T>(o: { system: string; prompt: string; schema: z.ZodType<T>; maxTokens?: number }) {
    const usage: Usage = { tokensIn: 0, tokensOut: 0 };
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: `${o.prompt}\n\nRespond with ONLY a single JSON object. No prose, no code fences.` },
    ];
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: o.maxTokens ?? 8000,
        system: o.system,
        messages,
      });
      usage.tokensIn += res.usage.input_tokens;
      usage.tokensOut += res.usage.output_tokens;
      if (res.stop_reason === "refusal") throw new Error("model refused the request");
      const text = this.text(res.content);
      try {
        const parsed = o.schema.safeParse(extractJsonObject(text));
        if (parsed.success) return { data: parsed.data, usage };
        lastErr = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      } catch (e) {
        lastErr = (e as Error).message;
      }
      messages.push({ role: "assistant", content: text || "{}" });
      messages.push({ role: "user", content: `That output was invalid (${lastErr}). Return ONLY the corrected JSON object.` });
    }
    throw new Error(`model returned invalid JSON after retry: ${lastErr}`);
  }

  async converse(o: Parameters<LLM["converse"]>[0]) {
    const usage: Usage = { tokensIn: 0, tokensOut: 0 };
    const messages: Anthropic.MessageParam[] = o.messages.map((m) => ({ role: m.role, content: m.content }));
    const max = o.maxSteps ?? 8;
    let steps = 0;
    for (; steps < max; steps++) {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: o.maxTokens ?? 8000,
        system: o.system,
        tools: o.tools as Anthropic.Tool[],
        messages,
      });
      usage.tokensIn += res.usage.input_tokens;
      usage.tokensOut += res.usage.output_tokens;
      if (res.stop_reason === "refusal") return { text: "I can't help with that request.", usage, steps: steps + 1 };
      if (res.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: res.content }); continue; }
      if (res.stop_reason !== "tool_use") return { text: this.text(res.content).trim(), usage, steps: steps + 1 };

      messages.push({ role: "assistant", content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const b of res.content) {
        if (b.type !== "tool_use") continue;
        try {
          results.push({ type: "tool_result", tool_use_id: b.id, content: await o.onTool(b.name, b.input) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: `Error: ${(e as Error).message}` });
        }
      }
      messages.push({ role: "user", content: results });
    }
    return { text: "I reached my step limit before finishing. Progress so far is recorded in the run log.", usage, steps };
  }
}

/** Build the LLM from env. Returns null when no credentials are configured (agents fall back to rules). */
export function llmFromEnv(): LLM | null {
  if (process.env.AGENT_LLM === "off") return null;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  return new AnthropicLLM(new Anthropic(), process.env.AGENT_MODEL ?? "claude-opus-5-5");
}
