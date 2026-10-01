import net from "node:net";
import dns from "node:dns/promises";
import crypto from "node:crypto";

export type VerifyStatus = "valid" | "invalid" | "catch-all" | "unknown";
export interface VerifyResult { status: VerifyStatus; reason: string; mx?: string; code?: number }
export type EmailVerifier = (email: string) => Promise<VerifyResult>;

export interface SmtpVerifyOptions {
  /** Domain we announce in EHLO (use a domain you own with a matching PTR/SPF if possible). */
  heloDomain: string;
  mailFrom: string;
  port?: number;
  timeoutMs?: number;
  /** Minimum gap between probes to the same mail server (be polite). */
  perHostDelayMs?: number;
  cacheMs?: number;
  resolveMx?: (domain: string) => Promise<{ exchange: string; priority: number }[]>;
}

/** Hosts that accept every recipient at the gateway, so an accepted RCPT proves nothing. */
const GATEWAY_MX = /(pphosted|mimecast|barracuda|protection\.outlook\.com|messagelabs|iphmx|trendmicro|ppe-hosted|fireeyecloud|sophos|forcepoint|cudamail)/i;
const FREEMAIL = /^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|aol|icloud|me|protonmail|proton)\./i;

interface Reply { code: number; text: string }

/** Minimal SMTP dialogue: reads (possibly multi-line) replies, sends one command at a time. Never sends a message body. */
class Dialogue {
  private buf = "";
  private lines: string[] = [];
  private waiters: ((r: Reply) => void)[] = [];
  private queue: Reply[] = [];
  private err: Error | null = null;
  constructor(private sock: net.Socket) {
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => {
      this.buf += d;
      const parts = this.buf.split(/\r?\n/);
      this.buf = parts.pop() ?? "";
      for (const line of parts) {
        const m = line.match(/^(\d{3})([ -]?)(.*)$/);
        if (!m) continue;
        this.lines.push(m[3]);
        if (m[2] !== "-") { this.push({ code: Number(m[1]), text: this.lines.join(" ") }); this.lines = []; } // "250-" continues, "250 " ends the reply
      }
    });
    sock.on("error", (e) => { this.err = e; this.flushErr(); });
    sock.on("close", () => { if (!this.err) this.err = new Error("connection closed"); this.flushErr(); });
  }
  private push(r: Reply) { const w = this.waiters.shift(); w ? w(r) : this.queue.push(r); }
  private flushErr() { for (const w of this.waiters.splice(0)) w({ code: 0, text: this.err?.message ?? "error" }); }
  read(timeoutMs: number): Promise<Reply> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    if (this.err) return Promise.resolve({ code: 0, text: this.err.message });
    return new Promise((resolve) => {
      const t = setTimeout(() => { const i = this.waiters.indexOf(wrapped); if (i >= 0) this.waiters.splice(i, 1); resolve({ code: 0, text: "timeout" }); }, timeoutMs);
      const wrapped = (r: Reply) => { clearTimeout(t); resolve(r); };
      this.waiters.push(wrapped);
    });
  }
  async cmd(line: string, timeoutMs: number): Promise<Reply> { this.sock.write(line + "\r\n"); return this.read(timeoutMs); }
  /** Say QUIT and give the server a moment to answer before dropping the connection. */
  async close() {
    try { if (!this.sock.destroyed) { this.sock.write("QUIT\r\n"); await this.read(500); } } catch { /* ignore */ }
    this.sock.destroy();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mailbox verifier: asks the recipient's mail server "would you accept mail for this address?" (RCPT TO) and hangs up
 * without sending anything. Reliable only where the server answers honestly: catch-alls and gateways are detected and
 * reported as such, temporary failures (greylisting, timeouts, blocked port 25) are "unknown", never "valid".
 */
export function createSmtpVerifier(o: SmtpVerifyOptions): EmailVerifier {
  const port = o.port ?? 25, timeout = o.timeoutMs ?? 8000, gap = o.perHostDelayMs ?? 1500, cacheMs = o.cacheMs ?? 24 * 3600_000;
  const resolveMx = o.resolveMx ?? (async (d: string) => (await dns.resolveMx(d)).sort((a, b) => a.priority - b.priority));
  const cache = new Map<string, { at: number; r: VerifyResult }>();
  const lastByHost = new Map<string, Promise<void>>();

  const throttled = async <T>(host: string, fn: () => Promise<T>): Promise<T> => {
    const prev = lastByHost.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    lastByHost.set(host, prev.then(() => mine));
    await prev;
    try { return await fn(); } finally { setTimeout(release, gap); }
  };

  return async (emailRaw) => {
    const email = emailRaw.trim().toLowerCase();
    const hit = cache.get(email);
    if (hit && Date.now() - hit.at < cacheMs) return hit.r;
    const domain = email.split("@")[1];
    if (!domain || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { status: "invalid", reason: "malformed address" };
    if (FREEMAIL.test(domain)) return { status: "unknown", reason: "freemail provider: cannot be verified this way" };

    let mxs: { exchange: string; priority: number }[];
    try { mxs = await resolveMx(domain); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "ENOTFOUND" || code === "ENODATA" ? { status: "invalid", reason: "domain has no mail server" } : { status: "unknown", reason: `DNS lookup failed (${code ?? (e as Error).message})` };
    }
    if (!mxs.length) return { status: "invalid", reason: "domain has no mail server" };
    const mx = mxs[0].exchange.replace(/\.$/, "");
    if (GATEWAY_MX.test(mx)) { const r: VerifyResult = { status: "unknown", reason: `mail gateway (${mx}) accepts all recipients`, mx }; cache.set(email, { at: Date.now(), r }); return r; }

    const r = await throttled(mx, async (): Promise<VerifyResult> => {
      const sock = net.connect({ host: mx, port });
      const d = new Dialogue(sock);
      sock.setTimeout(timeout * 4);
      try {
        const greet = await d.read(timeout);
        if (greet.code !== 220) return { status: "unknown", reason: greet.code === 0 ? `cannot connect on port ${port}: ${greet.text}` : `server refused: ${greet.code} ${greet.text.slice(0, 80)}`, mx, code: greet.code };
        let ehlo = await d.cmd(`EHLO ${o.heloDomain}`, timeout);
        if (ehlo.code !== 250) ehlo = await d.cmd(`HELO ${o.heloDomain}`, timeout);
        if (ehlo.code !== 250) return { status: "unknown", reason: `EHLO rejected: ${ehlo.code}`, mx, code: ehlo.code };
        const from = await d.cmd(`MAIL FROM:<${o.mailFrom}>`, timeout);
        if (from.code !== 250) return { status: "unknown", reason: `sender rejected: ${from.code} ${from.text.slice(0, 80)}`, mx, code: from.code };
        const rcpt = await d.cmd(`RCPT TO:<${email}>`, timeout);
        const text = rcpt.text.toLowerCase();
        if (rcpt.code === 250 || rcpt.code === 251) {
          // Accepted. Is this a catch-all? Ask about an address that cannot exist.
          await d.cmd("RSET", timeout);
          await d.cmd(`MAIL FROM:<${o.mailFrom}>`, timeout);
          const probe = await d.cmd(`RCPT TO:<zz-${crypto.randomBytes(6).toString("hex")}@${domain}>`, timeout);
          return probe.code === 250 || probe.code === 251
            ? { status: "catch-all", reason: "server accepts any address at this domain", mx, code: 250 }
            : { status: "valid", reason: "mailbox accepted", mx, code: rcpt.code };
        }
        if (rcpt.code === 552) return { status: "valid", reason: "mailbox exists (full)", mx, code: 552 };
        if ((rcpt.code === 550 || rcpt.code === 551 || rcpt.code === 553 || rcpt.code === 554) && /5\.1\.1|5\.1\.10|user unknown|no such user|does not exist|unknown user|mailbox (not found|unavailable)|invalid (recipient|mailbox)|recipient (not found|rejected)|no mailbox/.test(text)) return { status: "invalid", reason: `mailbox does not exist (${rcpt.code})`, mx, code: rcpt.code };
        // 5.7.x policy blocks, 4xx greylisting/temporary, timeouts: no evidence either way
        return { status: "unknown", reason: rcpt.code === 0 ? rcpt.text : `${rcpt.code} ${rcpt.text.slice(0, 100)}`, mx, code: rcpt.code };
      } finally { await d.close(); }
    });
    if (r.status !== "unknown" || /accepts all/.test(r.reason)) cache.set(email, { at: Date.now(), r });
    return r;
  };
}

/** Quick reachability test for the connection test: can this host open outbound port 25 at all? */
export async function port25Reachable(host = "gmail-smtp-in.l.google.com", timeoutMs = 6000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: 25 });
    const done = (ok: boolean, detail: string) => { s.destroy(); resolve({ ok, detail }); };
    s.setTimeout(timeoutMs, () => done(false, "timed out (outbound port 25 is probably blocked by your host)"));
    s.once("data", (d) => done(String(d).startsWith("220"), String(d).startsWith("220") ? "port 25 is open" : `unexpected greeting: ${String(d).slice(0, 60)}`));
    s.once("error", (e) => done(false, e.message));
  });
}
