import Anthropic from "@anthropic-ai/sdk";
import type { LLM } from "./llm";
import { AnthropicLLM } from "./llm";
import { OpenAICompatLLM } from "./llm-openai";
import { GeminiLLM } from "./llm-gemini";

type Env = Record<string, string | undefined>;

interface Preset { baseUrl: string; keyEnv: string[]; model: string; tokenParam?: "max_tokens" | "max_completion_tokens"; keyless?: boolean; headers?: Record<string, string> }

/** OpenAI-format providers. Default models are only starting points: set AGENT_MODEL to whatever your account offers. */
export const OPENAI_COMPAT_PRESETS: Record<string, Preset> = {
  openai: { baseUrl: "https://api.openai.com/v1", keyEnv: ["OPENAI_API_KEY"], model: "gpt-4o", tokenParam: "max_completion_tokens" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: ["GROQ_API_KEY"], model: "llama-3.3-70b-versatile" },
  together: { baseUrl: "https://api.together.xyz/v1", keyEnv: ["TOGETHER_API_KEY"], model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", keyEnv: ["MISTRAL_API_KEY"], model: "mistral-large-latest" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", keyEnv: ["DEEPSEEK_API_KEY"], model: "deepseek-chat" },
  xai: { baseUrl: "https://api.x.ai/v1", keyEnv: ["XAI_API_KEY"], model: "grok-2-latest" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: ["OPENROUTER_API_KEY"], model: "openai/gpt-4o" },
  perplexity: { baseUrl: "https://api.perplexity.ai", keyEnv: ["PERPLEXITY_API_KEY"], model: "sonar-pro" },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", keyEnv: ["FIREWORKS_API_KEY"], model: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", keyEnv: ["CEREBRAS_API_KEY"], model: "llama-3.3-70b" },
  ollama: { baseUrl: "http://localhost:11434/v1", keyEnv: [], model: "llama3.1", keyless: true },
  lmstudio: { baseUrl: "http://localhost:1234/v1", keyEnv: [], model: "local-model", keyless: true },
  // Any other OpenAI-compatible server: set LLM_BASE_URL, LLM_MODEL and (if needed) LLM_API_KEY.
  custom: { baseUrl: "", keyEnv: ["LLM_API_KEY"], model: "", keyless: true },
};

export const SUPPORTED_LLM_PROVIDERS = ["anthropic", "gemini", ...Object.keys(OPENAI_COMPAT_PRESETS)];

const firstKey = (env: Env, names: string[]) => names.map((n) => env[n]).find((v) => v && v.trim());

/** Which provider will be used, or null. Explicit LLM_PROVIDER wins; otherwise the first provider that has a key. */
export function detectLlmProvider(env: Env = process.env): string | null {
  if (env.AGENT_LLM === "off") return null;
  const explicit = env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit) return explicit === "google" ? "gemini" : explicit === "claude" ? "anthropic" : explicit;
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return "anthropic";
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return "gemini";
  if (env.LLM_BASE_URL) return "custom";
  for (const [name, p] of Object.entries(OPENAI_COMPAT_PRESETS)) if (p.keyEnv.length && firstKey(env, p.keyEnv)) return name;
  return null;
}

/** Build the configured LLM, or null (agents then use rule-based fallbacks). Throws on a misconfigured explicit choice. */
export function llmFromEnv(env: Env = process.env, fetchImpl?: typeof fetch): LLM | null {
  const provider = detectLlmProvider(env);
  if (!provider) return null;
  const model = env.AGENT_MODEL?.trim();
  const http = fetchImpl ? { fetchImpl } : undefined;

  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) throw new Error("LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY");
    return new AnthropicLLM(new Anthropic(), model || "claude-opus-5-5");
  }
  if (provider === "gemini") {
    const apiKey = firstKey(env, ["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
    if (!apiKey) throw new Error("LLM_PROVIDER=gemini needs GEMINI_API_KEY (or GOOGLE_API_KEY)");
    return new GeminiLLM({ apiKey, model: model || "gemini-2.0-flash", http });
  }
  const preset = OPENAI_COMPAT_PRESETS[provider];
  if (!preset) throw new Error(`Unknown LLM_PROVIDER "${provider}". Supported: ${SUPPORTED_LLM_PROVIDERS.join(", ")}`);
  const baseUrl = (env.LLM_BASE_URL || preset.baseUrl).replace(/\/$/, "");
  const apiKey = firstKey(env, [...preset.keyEnv, "LLM_API_KEY"]);
  if (!apiKey && !preset.keyless) throw new Error(`LLM_PROVIDER=${provider} needs ${preset.keyEnv[0]} (or LLM_API_KEY)`);
  const m = model || preset.model;
  if (!baseUrl) throw new Error("LLM_PROVIDER=custom needs LLM_BASE_URL (e.g. https://your-host/v1)");
  if (!m) throw new Error("LLM_PROVIDER=custom needs AGENT_MODEL");
  return new OpenAICompatLLM({ provider, apiKey, baseUrl, model: m, tokenParam: preset.tokenParam, http });
}
