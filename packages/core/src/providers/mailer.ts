import nodemailer, { type Transporter } from "nodemailer";
import { postJson, type PostOptions } from "./http";
import { hintFor } from "./hints";

export interface OutgoingEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  /** Optional HTML twin (only sent when open tracking is enabled). */
  html?: string;
  headers?: Record<string, string>;
  /** Stable per-message key so providers that support it can de-duplicate a retried send. */
  idempotencyKey?: string;
}
export interface MailerCheck { ok: boolean; detail: string; hint?: string }
export interface Mailer {
  readonly name: string;
  send(m: OutgoingEmail): Promise<{ id: string }>;
  /** Harmless authenticated call to verify credentials (never sends mail). `senderEmail` lets it check the sending domain. */
  check?(senderEmail?: string): Promise<MailerCheck>;
}

/** Used when the configured provider is misconfigured: fails loudly on send instead of pretending to deliver. */
export class BrokenMailer implements Mailer {
  readonly name = "misconfigured";
  constructor(private reason: string) {}
  async send(): Promise<{ id: string }> { throw new Error(`Email provider is misconfigured: ${this.reason}`); }
  async check(): Promise<MailerCheck> { return { ok: false, detail: this.reason, hint: "Fix the email variables in the server environment and restart." }; }
}

/** Records the email but delivers nothing. The default until SMTP is configured. */
export class DryRunMailer implements Mailer {
  readonly name = "dry-run";
  async check(): Promise<MailerCheck> { return { ok: true, detail: "dry-run: nothing is delivered", hint: "Configure an email provider to actually send." }; }
  readonly outbox: OutgoingEmail[] = [];
  async send(m: OutgoingEmail) {
    this.outbox.push(m);
    return { id: `dryrun-${Date.now()}-${this.outbox.length}` };
  }
}

export class SmtpMailer implements Mailer {
  readonly name = "smtp";
  private transport: Transporter;
  constructor(url: string) {
    this.transport = nodemailer.createTransport(url);
  }
  async check(): Promise<MailerCheck> {
    try { await this.transport.verify(); return { ok: true, detail: "SMTP server accepted the connection and credentials" }; }
    catch (e) { return { ok: false, detail: (e as Error).message, hint: "Check host, port, username/password and TLS (use smtps:// with port 465, or smtp:// with 587). Google/Microsoft accounts need an app password." }; }
  }
  async send(m: OutgoingEmail) {
    const info = await this.transport.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, html: m.html, headers: m.headers });
    return { id: String(info.messageId) };
  }
}

async function getJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<{ status: number; body: any }> {
  const res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "kangguircm-crm/1.0", ...headers }, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const domainOf = (email?: string) => email?.split("@")[1]?.trim().toLowerCase();

function splitAddress(a: string): { name?: string; email: string } {
  const m = a.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || undefined, email: m[2].trim() } : { email: a.trim() };
}
const NO_RETRY: PostOptions = { retryDelaysMs: [] }; // a retried POST after a timeout could double-send; the run queue decides.

export class ResendMailer implements Mailer {
  readonly name = "resend";
  constructor(private key: string, private http: PostOptions = NO_RETRY, private baseUrl = "https://api.resend.com") {}
  async check(senderEmail?: string): Promise<MailerCheck> {
    const r = await getJson(`${this.baseUrl}/domains`, { authorization: `Bearer ${this.key}` }, this.http.fetchImpl);
    if (r.status === 401 && /restricted/i.test(JSON.stringify(r.body))) return { ok: true, detail: "Key is valid but sending-only (cannot list domains), so the sender domain could not be checked", hint: "Make sure the sender email uses a domain verified in Resend." };
    if (r.status === 401 || r.status === 403) return { ok: false, detail: `Resend rejected the key (HTTP ${r.status})`, hint: hintFor("resend", 401, JSON.stringify(r.body)) ?? undefined };
    if (r.status !== 200) return { ok: false, detail: `Unexpected response HTTP ${r.status}` };
    const domains: { name: string; status: string }[] = r.body?.data ?? [];
    const d = domainOf(senderEmail);
    if (d) {
      const m = domains.find((x) => x.name.toLowerCase() === d);
      if (!m) return { ok: false, detail: `Sender domain ${d} is not in this Resend account`, hint: "Add and verify the domain at resend.com/domains, or change the sender email in Settings." };
      if (m.status !== "verified") return { ok: false, detail: `Sender domain ${d} is "${m.status}", not verified`, hint: "Add the DNS records Resend shows for the domain and wait for verification." };
    }
    return { ok: true, detail: `Key valid; ${domains.filter((x) => x.status === "verified").length} verified domain(s)${d ? `, sender domain ${d} verified` : ""}` };
  }
  async send(m: OutgoingEmail) {
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}` };
    if (m.idempotencyKey) headers["idempotency-key"] = m.idempotencyKey;
    const res = await postJson(`${this.baseUrl}/emails`, headers, { from: m.from, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), headers: m.headers }, { label: "resend", ...this.http });
    return { id: String(((await res.json()) as any).id) };
  }
}

export class SendGridMailer implements Mailer {
  readonly name = "sendgrid";
  /** `baseUrl` defaults to api.sendgrid.com; EU-regional accounts must use https://api.eu.sendgrid.com (SENDGRID_REGION=eu). */
  constructor(private key: string, private http: PostOptions = NO_RETRY, private baseUrl = "https://api.sendgrid.com") {}
  async check(): Promise<MailerCheck> {
    const r = await getJson(`${this.baseUrl}/v3/scopes`, { authorization: `Bearer ${this.key}` }, this.http.fetchImpl);
    if (r.status === 401 || r.status === 403) return { ok: false, detail: `SendGrid rejected the key (HTTP ${r.status})`, hint: "Create a key with at least Mail Send permission. EU-regional accounts also need SENDGRID_REGION=eu." };
    if (r.status !== 200) return { ok: false, detail: `Unexpected response HTTP ${r.status}` };
    const scopes: string[] = r.body?.scopes ?? [];
    if (!scopes.includes("mail.send")) return { ok: false, detail: "Key is valid but lacks the mail.send permission", hint: "Edit the API key and enable Mail Send." };
    return { ok: true, detail: "Key valid with mail.send permission", hint: "Also make sure the sender email has Single Sender Verification or Domain Authentication." };
  }
  async send(m: OutgoingEmail) {
    const from = splitAddress(m.from);
    const res = await postJson(`${this.baseUrl}/v3/mail/send`, { authorization: `Bearer ${this.key}` }, {
      personalizations: [{ to: [{ email: m.to }] }],
      from: { email: from.email, ...(from.name ? { name: from.name } : {}) },
      subject: m.subject,
      content: [{ type: "text/plain", value: m.text }, ...(m.html ? [{ type: "text/html", value: m.html }] : [])],
      headers: m.headers,
      tracking_settings: { click_tracking: { enable: false }, open_tracking: { enable: false } },
    }, { label: "sendgrid", ...this.http });
    return { id: res.headers.get("x-message-id") ?? `sendgrid-${Date.now()}` };
  }
}

export class PostmarkMailer implements Mailer {
  readonly name = "postmark";
  constructor(private token: string, private stream = "outbound", private http: PostOptions = NO_RETRY, private baseUrl = "https://api.postmarkapp.com") {}
  async check(senderEmail?: string): Promise<MailerCheck> {
    const h = { "x-postmark-server-token": this.token };
    const r = await getJson(`${this.baseUrl}/server`, h, this.http.fetchImpl);
    if (r.status === 401) return { ok: false, detail: "Postmark rejected the server token", hint: "Use the Server API token of the server (not the account token)." };
    if (r.status !== 200) return { ok: false, detail: `Unexpected response HTTP ${r.status}` };
    return { ok: true, detail: `Server "${r.body?.Name ?? "?"}" reachable`, hint: `Confirm a Sender Signature or verified domain exists for ${senderEmail ?? "your sender email"}.` };
  }
  async send(m: OutgoingEmail) {
    const res = await postJson(`${this.baseUrl}/email`, { "x-postmark-server-token": this.token, accept: "application/json" }, {
      From: m.from, To: m.to, Subject: m.subject, TextBody: m.text, ...(m.html ? { HtmlBody: m.html } : {}), MessageStream: this.stream, TrackOpens: false, TrackLinks: "None", // link tracking would rewrite the unsubscribe URL
      
      Headers: Object.entries(m.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
    }, { label: "postmark", ...this.http });
    return { id: String(((await res.json()) as any).MessageID) };
  }
}

export class MailgunMailer implements Mailer {
  readonly name = "mailgun";
  constructor(private key: string, private domain: string, private region: "us" | "eu" = "us", private fetchImpl: typeof fetch = fetch) {}
  async check(): Promise<MailerCheck> {
    const base = this.region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
    const r = await getJson(`${base}/v3/domains/${this.domain}`, { authorization: `Basic ${Buffer.from(`api:${this.key}`).toString("base64")}` }, this.fetchImpl);
    if (r.status === 401 || r.status === 403) return { ok: false, detail: `Mailgun rejected the key (HTTP ${r.status})`, hint: "Use the Private API key, and MAILGUN_REGION=eu for EU accounts." };
    if (r.status === 404) return { ok: false, detail: `Domain ${this.domain} not found in this Mailgun account/region`, hint: "Check MAILGUN_DOMAIN and MAILGUN_REGION." };
    if (r.status !== 200) return { ok: false, detail: `Unexpected response HTTP ${r.status}` };
    const state = r.body?.domain?.state;
    return state && state !== "active" ? { ok: false, detail: `Domain ${this.domain} is "${state}", not active`, hint: "Finish DNS verification in Mailgun." } : { ok: true, detail: `Domain ${this.domain} active` };
  }
  async send(m: OutgoingEmail) {
    const form = new URLSearchParams({ from: m.from, to: m.to, subject: m.subject, text: m.text });
    if (m.html) form.set("html", m.html);
    form.set("o:tracking", "no"); // opens are counted by our own pixel only
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
    case "sendgrid": return new SendGridMailer(need("SENDGRID_API_KEY"), NO_RETRY, env.SENDGRID_REGION === "eu" ? "https://api.eu.sendgrid.com" : undefined);
    case "postmark": return new PostmarkMailer(need("POSTMARK_SERVER_TOKEN"), env.POSTMARK_MESSAGE_STREAM || "outbound");
    case "mailgun": return new MailgunMailer(need("MAILGUN_API_KEY"), need("MAILGUN_DOMAIN"), env.MAILGUN_REGION === "eu" ? "eu" : "us");
    case "smtp": return new SmtpMailer(need("SMTP_URL"));
    default: throw new Error(`Unknown EMAIL_PROVIDER "${p}". Supported: ${SUPPORTED_EMAIL_PROVIDERS.join(", ")}`);
  }
}
