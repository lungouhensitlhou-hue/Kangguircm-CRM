import { detectEmailProvider } from "./mailer";
import { detectLlmProvider } from "./llm-factory";
import { detectSearchProvider } from "./search";

type Env = Record<string, string | undefined>;

/** What is configured in THIS process's environment (used by the UI to show integration status). */
export function integrationStatus(env: Env = process.env) {
  return {
    llm: detectLlmProvider(env),
    email: detectEmailProvider(env),
    search: detectSearchProvider(env),
    inbound: !!env.INBOUND_WEBHOOK_SECRET,
    verify: env.SMTP_VERIFY === "on",
    deliversEmail: detectEmailProvider(env) !== "dry-run",
  };
}
