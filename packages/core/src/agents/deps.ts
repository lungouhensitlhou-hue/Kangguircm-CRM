import type { Deps } from "./runtime";
import { llmFromEnv } from "../providers/llm-factory";
import { searcherFromEnv } from "../providers/search";
import { NppesClient } from "../providers/npi";
import { HttpWebTools } from "../providers/web";
import { mailerFromEnv } from "../providers/mailer";

/**
 * Production wiring. Two escape hatches exist purely for local/e2e testing:
 * NPPES_BASE_URL (point at a fake registry) and ALLOW_PRIVATE_FETCH=1 (let the researcher reach localhost).
 * Never set ALLOW_PRIVATE_FETCH in production: it disables the SSRF guard.
 */
export function depsFromEnv(): Deps {
  return {
    llm: llmFromEnv(),
    npi: new NppesClient(fetch, process.env.NPPES_BASE_URL || undefined),
    web: new HttpWebTools({ allowPrivate: process.env.ALLOW_PRIVATE_FETCH === "1", searcher: searcherFromEnv() }),
    mailer: mailerFromEnv(),
  };
}
