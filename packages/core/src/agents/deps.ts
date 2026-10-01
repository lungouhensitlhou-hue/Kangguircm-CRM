import type { Deps } from "./runtime";
import { llmFromEnv } from "../providers/llm-factory";
import { searcherFromEnv } from "../providers/search";
import { NppesClient } from "../providers/npi";
import { HttpWebTools } from "../providers/web";
import { BrokenMailer, mailerFromEnv, type Mailer } from "../providers/mailer";
import { alwaysDeliverable, dnsMxCheck } from "../providers/mx";
import { createSmtpVerifier } from "../providers/smtp-verify";

/**
 * Production wiring. Two escape hatches exist purely for local/e2e testing:
 * NPPES_BASE_URL (point at a fake registry) and ALLOW_PRIVATE_FETCH=1 (let the researcher reach localhost).
 * Never set ALLOW_PRIVATE_FETCH in production: it disables the SSRF guard.
 */
/**
 * Never throws: a misconfigured integration must not crash-loop the worker. AI/search degrade to rule-based/off (logged),
 * and a misconfigured email provider becomes a mailer that fails loudly on send (never a silent "sent").
 */
export function depsFromEnv(env: Record<string, string | undefined> = process.env, log: (m: string) => void = (m) => console.error(`[config] ${m}`)): Deps {
  const safe = <T>(what: string, fn: () => T, fallback: T): T => { try { return fn(); } catch (e) { log(`${what}: ${(e as Error).message}`); return fallback; } };
  const llm = safe("AI provider disabled", () => llmFromEnv(env), null);
  // Optional cheaper model for bulk extraction/critique, same provider: AGENT_MODEL_FAST=claude-sonnet-5-5
  const fastLlm = llm && env.AGENT_MODEL_FAST ? safe("AGENT_MODEL_FAST ignored", () => llmFromEnv({ ...env, AGENT_MODEL: env.AGENT_MODEL_FAST }), null) : null;
  const mailer: Mailer = (() => { try { return mailerFromEnv(env); } catch (e) { log(`Email provider misconfigured; sends will fail until fixed: ${(e as Error).message}`); return new BrokenMailer((e as Error).message); } })();
  return {
    llm,
    fastLlm,
    smtpVerify: env.SMTP_VERIFY === "on" ? createSmtpVerifier({ heloDomain: env.SMTP_VERIFY_HELO || new URL(env.APP_BASE_URL || "http://localhost").hostname, mailFrom: env.SMTP_VERIFY_FROM || `verify@${new URL(env.APP_BASE_URL || "http://localhost").hostname}` }) : undefined,
    domainGuess: env.AGENT_DOMAIN_GUESS !== "off",
    mxCheck: env.SKIP_MX_CHECK === "1" ? alwaysDeliverable : dnsMxCheck(),
    npi: new NppesClient(fetch, env.NPPES_BASE_URL || undefined),
    web: new HttpWebTools({ allowPrivate: env.ALLOW_PRIVATE_FETCH === "1", searcher: safe("Web search disabled", () => searcherFromEnv(env), null) }),
    mailer,
  };
}
