import type { Deps } from "./runtime";
import { llmFromEnv } from "../providers/llm";
import { NppesClient } from "../providers/npi";
import { HttpWebTools } from "../providers/web";
import { mailerFromEnv } from "../providers/mailer";

export function depsFromEnv(): Deps {
  return { llm: llmFromEnv(), npi: new NppesClient(), web: new HttpWebTools(), mailer: mailerFromEnv() };
}
