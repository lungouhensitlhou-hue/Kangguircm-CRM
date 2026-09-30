import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicLLM, costUsd } from "../src/providers/llm";

function fakeClient(responses: any[]) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      messages: {
        create: async (req: any) => {
          calls.push(JSON.parse(JSON.stringify(req)));
          const r = responses.shift();
          if (!r) throw new Error("no more scripted responses");
          return { usage: { input_tokens: 100, output_tokens: 50 }, ...r };
        },
      },
    } as any,
  };
}
const text = (t: string, stop = "end_turn") => ({ stop_reason: stop, content: [{ type: "text", text: t }] });

describe("AnthropicLLM", () => {
  it("json(): parses fenced output and validates with zod", async () => {
    const f = fakeClient([text('```json\n{"a": 1}\n```')]);
    const llm = new AnthropicLLM(f.client, "claude-opus-5-5");
    const r = await llm.json({ system: "sys", prompt: "p", schema: z.object({ a: z.number() }) });
    expect(r.data).toEqual({ a: 1 });
    expect(r.usage).toEqual({ tokensIn: 100, tokensOut: 50 });
    expect(f.calls[0].model).toBe("claude-opus-5-5");
    expect(f.calls[0].system).toBe("sys");
    expect(f.calls[0].thinking).toBeUndefined();
    expect(f.calls[0].temperature).toBeUndefined();
  });

  it("json(): retries once with the validation error, then gives up", async () => {
    const f = fakeClient([text('{"a": "x"}'), text('{"a": 2}')]);
    const llm = new AnthropicLLM(f.client, "claude-opus-5-5");
    const r = await llm.json({ system: "s", prompt: "p", schema: z.object({ a: z.number() }) });
    expect(r.data).toEqual({ a: 2 });
    expect(r.usage.tokensIn).toBe(200);
    expect(f.calls[1].messages.at(-1).content).toContain("invalid");
    const f2 = fakeClient([text("nope"), text("still nope")]);
    await expect(new AnthropicLLM(f2.client, "m").json({ system: "s", prompt: "p", schema: z.object({}) })).rejects.toThrow(/invalid JSON after retry/);
  });

  it("json(): surfaces refusals", async () => {
    const f = fakeClient([{ stop_reason: "refusal", content: [] }]);
    await expect(new AnthropicLLM(f.client, "m").json({ system: "s", prompt: "p", schema: z.object({}) })).rejects.toThrow(/refused/);
  });

  it("converse(): runs the manual tool loop, returns all tool results in one user turn, reports tool errors", async () => {
    const f = fakeClient([
      { stop_reason: "tool_use", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "t1", name: "a", input: { x: 1 } }, { type: "tool_use", id: "t2", name: "boom", input: {} }] },
      text("All done."),
    ]);
    const llm = new AnthropicLLM(f.client, "claude-opus-5-5");
    const seen: string[] = [];
    const r = await llm.converse({
      system: "s", messages: [{ role: "user", content: "go" }],
      tools: [{ name: "a", description: "d", input_schema: { type: "object", properties: {} } }],
      onTool: async (n, i) => { seen.push(n); if (n === "boom") throw new Error("kaput"); return JSON.stringify({ got: i }); },
    });
    expect(r.text).toBe("All done.");
    expect(r.steps).toBe(2);
    expect(seen).toEqual(["a", "boom"]);
    const second = f.calls[1].messages;
    expect(second.at(-1).role).toBe("user");
    expect(second.at(-1).content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: '{"got":{"x":1}}' },
      { type: "tool_result", tool_use_id: "t2", is_error: true, content: "Error: kaput" },
    ]);
    expect(second.at(-2).role).toBe("assistant");
    expect(f.calls[0].tool_choice).toBeUndefined();
  });

  it("converse(): step limit prevents runaway loops", async () => {
    const loop = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "a", input: {} }] };
    const f = fakeClient(Array.from({ length: 10 }, () => structuredClone(loop)));
    const r = await new AnthropicLLM(f.client, "m").converse({ system: "s", messages: [{ role: "user", content: "x" }], tools: [], onTool: async () => "{}", maxSteps: 3 });
    expect(f.calls).toHaveLength(3);
    expect(r.text).toMatch(/step limit/);
  });

  it("prices runs by model", () => {
    expect(costUsd("claude-opus-5-5", { tokensIn: 1_000_000, tokensOut: 1_000_000 })).toBe(24);
    expect(costUsd("claude-sonnet-5-5", { tokensIn: 1_000_000, tokensOut: 0 })).toBe(2);
  });
});
