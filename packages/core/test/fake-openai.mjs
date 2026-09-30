// A tiny fake OpenAI-compatible /v1/chat/completions server used by tests. Deterministic, no network.
import http from "node:http";

const usage = { prompt_tokens: 120, completion_tokens: 40 };
const reply = (message, finish = "stop") => ({ id: "fake", choices: [{ index: 0, finish_reason: finish, message }], usage });

export function respond(body) {
  const system = body.messages?.[0]?.content ?? "";
  const last = body.messages.at(-1);
  if (body.tools?.length) {
    // chat agent: first turn asks for pipeline_stats, then summarizes the tool result
    if (last.role === "tool") {
      const stats = JSON.parse(last.content);
      return reply({ role: "assistant", content: `AI summary: ${stats.total} leads in your pipeline.` });
    }
    return reply({ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "pipeline_stats", arguments: "{}" } }] }, "tool_calls");
  }
  const prompt = String(last.content);
  if (/research analyst/.test(system)) {
    const has = (s) => prompt.includes(s);
    return reply({
      role: "assistant",
      content: JSON.stringify({
        summary: "AI-extracted profile of a multi-location orthopedic group.",
        ehr: has("athenahealth") ? "athenahealth" : null,
        size_estimate: "3 locations",
        specialties: ["Orthopedics"],
        pain_points: [],
        decision_makers: [
          ...(has("Jane Smith") ? [{ name: "Jane Smith", title: "Practice Manager", email: has("jane.smith@e2e-ortho.test") ? "jane.smith@e2e-ortho.test" : null }] : []),
          { name: "Ghost Person", title: "CEO", email: "ghost@nowhere.test" }, // hallucination: must be dropped by grounding
        ],
        confidence: 0.85,
      }),
    });
  }
  if (/triage replies/.test(system)) {
    return reply({
      role: "assistant",
      content: JSON.stringify({
        label: "interested",
        summary: "Wants a call on Thursday.",
        referral: null,
        suggested_reply: "Hi Jane,\n\nThank you for the quick reply. I am happy to find a time on Thursday that suits you, and I can share a short overview of how we support orthopedic billing beforehand if that helps. Would the afternoon work?\n\nBest,\nSam",
      }),
    });
  }
  if (/demanding editor/.test(system)) {
    return reply({ role: "assistant", content: JSON.stringify({ score: 9, issues: [], revised: null }) });
  }
  if (/cold emails/.test(system)) {
    return reply({
      role: "assistant",
      content: JSON.stringify({
        subject: "AI drafted: billing help",
        body: "Hi Jane,\n\nI noticed your group runs on athenahealth across several locations. We help orthopedic practices cut claim denials and speed up payments so your team spends less time chasing insurers.\n\nWould a 15-minute call next week be useful?\n\nBest,\nSam",
      }),
    });
  }
  return reply({ role: "assistant", content: "{}" });
}

export function startFakeOpenAI(port = 0) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const body = JSON.parse(raw);
        requests.push({ auth: req.headers.authorization, body });
        if (req.headers.authorization !== "Bearer fake-key") { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "bad key" } })); }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(respond(body)));
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) })));
}
