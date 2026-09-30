import nodemailer from "nodemailer";
import { postJson, type PostOptions } from "./http";

export interface OutgoingEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
  /** Stable per-message key so providers that support it can de-duplicate a retried send. */
  idempotencyKey?: string;
}
export interface Mailer {
  readonly name: string;
  send(m: OutgoingEmail): Promise<{ id: string }>;
}

/** Records the email but delivers nothing. The default until SMTP is configured. */
export class DryRunMailer implements Mailer {
  readonly name = "dry-run";
  readonly outbox: OutgoingEmail[] = [];
  async send(m: OutgoingEmail) {
    this.outbox.push(m);
    return { id: `dryrun-${Date.now()}-${this.outbox.length}` };
  }
}

export class SmtpMailer implements Mailer {
  readonly name = "smtp";
  private transport: nodemailer.Transporter;
  constructor(url: string) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(m: OutgoingEmail) {
    const info = await this.transport.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, headers: m.headers });
    return { id: String(info.messageId) };
  }
}

function splitAddress(a: string): { name?: string; email: string } {
  const m = a.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || undefined, email: m[2].trim() } : { email: a.trim() };
}
const NO_RETRY: PostOptions = { retryDelaysMs: [] }; // a retried POST after a timeout could double-send; the run queue decides.

export class ResendMailer implements Mailer {
  readonly name = "resend";
  constructor(private key: string, private http: PostOptions = NO_RETRY) {}
  async send(m: OutgoingEmail) {
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}` };
    if (m.idempotencyKey) headers["idempotency-key"] = m.idempotencyKey;
    const res = await postJson("https://api.resend.com/emails", headers, { from: m.from, to: [m.to], subject: m.subject, text: m.text, headers: m.headers }, { label: "resend", ...this.http });
    return { id: String(((await res.json()) as any).id) };
  }
}

export class SendGridMailer implements Mailer {
  readonly name = "sendgrid";
  constructor(private key: string, private http: PostOptions = NO_RETRY) {}
  async send(m: OutgoingEmail) {
    const from = splitAddress(m.from);
    const res = await postJson("https://api.sendgrid.com/v3/mail/send", { authorization: `Bearer ${this.key}` }, {
      personalizations: [{ to: [{ email: m.to }] }],
      from: { email: from.email, ...(from.name ? { name: from.name } : {}) },
      subject: m.subject,
      content: [{ type: "text/plain", value: m.text }],
      headers: m.headers,
      tracking_settings: { click_tracking: { enable: false }, open_tracking: { enable: false } },
    }, { label: "sendgrid", ...this.http });
    return { id: res.headers.get("x-message-id") ?? `sendgrid-${Date.now()}` };
  }
}

export class PostmarkMailer implements Mailer {
  readonly name = "postmark";
  constructor(private token: string, private stream = "outbound", private http: PostOptions = NO_RETRY) {}
  async send(m: OutgoingEmail) {
    const res = await postJson("https://api.postmarkapp.com/email", { "x-postmark-server-token": this.token, accept: "application/json" }, {
      From: m.from, To: m.to, Subject: m.subject, TextBody: m.text, MessageStream: this.stream, TrackOpens: false,
      Headers: Object.entries(m.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
    }, { label: "postmark", ...this.http });
    return { id: String(((await res.json()) as any).MessageID) };
  }
}

export class MailgunMailer implements Mailer {
  readonly name = "mailgun";
  constructor(private key: string, private domain: string, private region: "us" | "eu" = "us", private fetchImpl: typeof fetch = fetch) {}
  async send(m: OutgoingEmail) {
    const form = new URLSearchParams({ from: m.from, to: m.to, subject: m.subject, text: m.text });
    for (const [k, v] of Object.entries(m.headers ?? {})) form.set(`h:${k}`, v);
    const base = this.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
    const res = await this.fetchImpl(`${base}/v3/${this.domain}/messages`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`api:${this.key}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: form, signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`mailgun API error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    return { id: String(((await res.json()) as any).id) };
  }
}

type Env = Record<string, string | undefined>;
export const SUPPORTED_EMAIL_PROVIDERS = ["resend", "sendgrid", "postmark", "mailgun", "smtp"];

export function detectEmailProvider(env: Env = process.env): string {
  const explicit = env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (explicit) return explicit;
  if (env.RESEND_API_KEY) return "resend";
  if (env.SENDGRID_API_KEY) return "sendgrid";
  if (env.POSTMARK_SERVER_TOKEN) return "postmark";
  if (env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN) return "mailgun";
  if (env.SMTP_URL) return "smtp";
  return "dry-run";
}

export function mailerFromEnv(env: Env = process.env): Mailer {
  const p = detectEmailProvider(env);
  const need = (k: string) => { const v = env[k]?.trim(); if (!v) throw new Error(`EMAIL_PROVIDER=${p} needs ${k}`); return v; };
  switch (p) {
    case "dry-run": return new DryRunMailer();
    case "resend": return new ResendMailer(need("RESEND_API_KEY"));
    case "sendgrid": return new SendGridMailer(need("SENDGRID_API_KEY"));
    case "postmark": return new PostmarkMailer(need("POSTMARK_SERVER_TOKEN"), env.POSTMARK_MESSAGE_STREAM || "outbound");
    case "mailgun": return new MailgunMailer(need("MAILGUN_API_KEY"), need("MAILGUN_DOMAIN"), env.MAILGUN_REGION === "eu" ? "eu" : "us");
    case "smtp": return new SmtpMailer(need("SMTP_URL"));
    default: throw new Error(`Unknown EMAIL_PROVIDER "${p}". Supported: ${SUPPORTED_EMAIL_PROVIDERS.join(", ")}`);
  }
}
