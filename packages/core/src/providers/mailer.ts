import nodemailer from "nodemailer";

export interface OutgoingEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
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

export function mailerFromEnv(): Mailer {
  return process.env.SMTP_URL ? new SmtpMailer(process.env.SMTP_URL) : new DryRunMailer();
}
