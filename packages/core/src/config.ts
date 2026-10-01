import { detectEmailProvider, mailerFromEnv } from "./providers/mailer";
import { detectLlmProvider, llmFromEnv } from "./providers/llm-factory";
import { detectSearchProvider, searcherFromEnv } from "./providers/search";

type Env = Record<string, string | undefined>;
export interface ConfigIssue { level: "error" | "warn" | "info"; key: string; message: string; fix: string }

const LLM_KEY_PREFIX: [string, string, string][] = [
  ["ANTHROPIC_API_KEY", "sk-ant-", "Anthropic"], ["OPENAI_API_KEY", "sk-", "OpenAI"], ["GEMINI_API_KEY", "AIza", "Gemini"], ["GROQ_API_KEY", "gsk_", "Groq"],
  ["XAI_API_KEY", "xai-", "xAI"], ["OPENROUTER_API_KEY", "sk-or-", "OpenRouter"],
];
const WEBHOOK_SECRET_FOR: Record<string, string> = { resend: "RESEND_WEBHOOK_SECRET", sendgrid: "SENDGRID_WEBHOOK_PUBLIC_KEY", postmark: "POSTMARK_WEBHOOK_PASSWORD", mailgun: "MAILGUN_WEBHOOK_SIGNING_KEY" };

/**
 * Static checks of the environment: misconfigurations that would otherwise surface as confusing failures after deployment.
 * Pure (no network). Errors mean something WILL break; warnings mean a feature will silently not work.
 */
export function validateConfig(env: Env = process.env): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  const add = (level: ConfigIssue["level"], key: string, message: string, fix: string) => out.push({ level, key, message, fix });
  const prod = env.NODE_ENV === "production";
  const has = (k: string) => !!env[k]?.trim();

  if (!has("DATABASE_URL")) add(prod ? "error" : "warn", "DATABASE_URL", "DATABASE_URL is not set; the default local database will be used.", "Set DATABASE_URL=postgres://user:pass@host:5432/dbname");
  if (prod) {
    if (!has("ADMIN_EMAIL") || !has("ADMIN_PASSWORD")) add("error", "ADMIN_PASSWORD", "No admin login is configured, so nobody can sign in.", "Set ADMIN_EMAIL and ADMIN_PASSWORD.");
    else if ((env.ADMIN_PASSWORD ?? "").length < 12) add("warn", "ADMIN_PASSWORD", "The admin password is short.", "Use 12+ characters (a long passphrase).");
    if ((env.SESSION_SECRET ?? "").length < 32) add("error", "SESSION_SECRET", "SESSION_SECRET is missing or shorter than 32 characters, so sign-in will fail.", "Set SESSION_SECRET to a random string: openssl rand -base64 32");
    if (env.ALLOW_PRIVATE_FETCH === "1") add("error", "ALLOW_PRIVATE_FETCH", "The SSRF guard is disabled (ALLOW_PRIVATE_FETCH=1).", "Remove ALLOW_PRIVATE_FETCH; it exists only for tests.");
  }
  const base = env.APP_BASE_URL?.trim();
  if (!base || /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(base)) add(prod ? "error" : "warn", "APP_BASE_URL", "APP_BASE_URL points at this machine, so unsubscribe links (and the open pixel) in emails will be broken for recipients.", "Set APP_BASE_URL to your public address, e.g. https://crm.yourcompany.com");
  else { try { if (new URL(base).protocol !== "https:" && prod) add("warn", "APP_BASE_URL", "APP_BASE_URL is not https; some mail clients distrust http unsubscribe links.", "Serve the app over https and use an https:// URL."); } catch { add("error", "APP_BASE_URL", `APP_BASE_URL "${base}" is not a valid URL.`, "Use a full URL such as https://crm.yourcompany.com"); } }

  // AI provider
  for (const [k, prefix, name] of LLM_KEY_PREFIX) if (has(k) && !env[k]!.startsWith(prefix)) add("warn", k, `${k} does not look like a ${name} key (expected to start with "${prefix}").`, "Double-check you pasted the full key with no spaces or quotes.");
  try { llmFromEnv(env); } catch (e) { add("error", "LLM_PROVIDER", (e as Error).message, "Fix the AI variables in .env.example, or remove LLM_PROVIDER to auto-detect."); }
  if (!detectLlmProvider(env)) add("info", "AI", "No AI key found: agents use rule-based fallbacks (simple extraction, template emails, command-style chat).", "Add any supported AI key to enable AI research and drafting.");

  // Email
  const ep = detectEmailProvider(env);
  if (has("RESEND_API_KEY") && !env.RESEND_API_KEY!.startsWith("re_")) add("warn", "RESEND_API_KEY", 'RESEND_API_KEY should start with "re_".', "Re-copy the key from the Resend dashboard.");
  if (has("SENDGRID_API_KEY") && !env.SENDGRID_API_KEY!.startsWith("SG.")) add("warn", "SENDGRID_API_KEY", 'SENDGRID_API_KEY should start with "SG.".', "Re-copy the key from SendGrid.");
  if (has("SMTP_URL")) { try { const u = new URL(env.SMTP_URL!); if (!/^smtps?:$/.test(u.protocol)) throw new Error(); } catch { add("error", "SMTP_URL", "SMTP_URL is not a valid smtp:// or smtps:// URL.", "Format: smtps://user:password@smtp.host.com:465 (URL-encode special characters in the password)."); } }
  try { mailerFromEnv(env); } catch (e) { add("error", "EMAIL_PROVIDER", (e as Error).message, "Set the missing variable, or unset EMAIL_PROVIDER."); }
  if (ep === "dry-run") add("warn", "EMAIL", "No email provider is configured: approved emails are recorded as sent but NOT delivered (dry-run).", "Set one of RESEND_API_KEY, SENDGRID_API_KEY, POSTMARK_SERVER_TOKEN, MAILGUN_API_KEY+MAILGUN_DOMAIN or SMTP_URL.");
  else {
    const secretKey = WEBHOOK_SECRET_FOR[ep];
    if (secretKey && !has(secretKey) && !has("EMAIL_WEBHOOK_SECRET")) add("warn", secretKey, `Bounces and spam complaints from ${ep} will not be recorded (webhook secret not set), so bounced addresses keep being emailed.`, `Set ${secretKey} (or EMAIL_WEBHOOK_SECRET) and add the webhook URL in ${ep}.`);
    if (ep === "smtp") add("info", "EMAIL", "Plain SMTP cannot report delivery, bounces or complaints.", "Use Resend, SendGrid, Postmark or Mailgun for bounce handling.");
  }
  if (!has("INBOUND_WEBHOOK_SECRET")) add("warn", "INBOUND_WEBHOOK_SECRET", "Replies cannot be received (inbound webhook secret not set), so follow-ups will not stop when someone answers.", "Set INBOUND_WEBHOOK_SECRET and point your provider's inbound-parse webhook at /api/inbound.");

  // Mailbox verification (contact finder)
  if (env.SMTP_VERIFY === "on") {
    const host = (() => { try { return new URL(env.APP_BASE_URL || "http://localhost").hostname; } catch { return "localhost"; } })();
    if (!has("SMTP_VERIFY_HELO") && /localhost|127\.0\.0\.1/.test(host)) add("warn", "SMTP_VERIFY_HELO", "Mailbox verification would introduce itself as localhost, which many mail servers reject.", "Set SMTP_VERIFY_HELO (and SMTP_VERIFY_FROM) to a domain you own.");
    add("info", "SMTP_VERIFY", "Mailbox verification needs outbound port 25, which most cloud hosts block.", "Run the Connection test; if port 25 is blocked, turn SMTP_VERIFY off and guessed addresses stay unverified.");
  }
  // Search
  try { searcherFromEnv(env); } catch (e) { add("error", "SEARCH_PROVIDER", (e as Error).message, "Set the matching search key or SEARCH_PROVIDER=off."); }
  if (!detectSearchProvider(env)) add("info", "SEARCH", "No web-search key: research can only use websites already known for a lead.", "Add BRAVE_API_KEY, TAVILY_API_KEY, SERPER_API_KEY or SERPAPI_API_KEY for automatic website discovery.");
  return out;
}

export const hasBlockingIssues = (issues: ConfigIssue[]) => issues.some((i) => i.level === "error");
