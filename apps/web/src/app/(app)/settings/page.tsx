import { Diagnostics } from "@/components/Diagnostics";
import { baseUrl, validateConfig, SUPPORTED_EMAIL_PROVIDERS, SUPPORTED_LLM_PROVIDERS, SUPPORTED_SEARCH_PROVIDERS, getSettings, integrationStatus, query, senderReady } from "@rcm/core";
import { SettingsForm, Suppressions } from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [s, sup] = await Promise.all([getSettings(), query<{ email: string; reason: string }>("SELECT email, reason FROM suppressions ORDER BY created_at DESC LIMIT 200")]);
  const ready = senderReady(s);
  const integ = integrationStatus();
  const issues = validateConfig().filter((i) => i.level !== "info");
  return (
    <>
      <div className="head"><div><h1>Settings</h1><div className="muted">Identity, guardrails and integrations</div></div></div>
      {issues.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }} data-testid="config-issues">
          <h2>Configuration problems ({issues.length})</h2>
          <ul className="plain">{issues.map((i) => <li key={i.key + i.message}><span className={`badge ${i.level === "error" ? "bad" : "warn"}`}>{i.level}</span> <strong>{i.key}</strong>: {i.message}<div className="small muted">→ {i.fix}</div></li>)}</ul>
          <div className="small muted">Shown for the web server's environment. The worker reads its own environment; in the provided docker-compose both use the same .env.</div>
        </div>
      )}
      <div className={`notice ${ready.ok ? "ok" : "warn"}`}>{ready.ok ? "Sender identity is complete: drafts can be approved." : `Missing: ${ready.missing.join(", ")}.`}</div>
      <div className="grid g2">
        <SettingsForm initial={s} />
        <div className="grid" style={{ alignContent: "start" }}>
          <Diagnostics />
          <div className="card">
            <h2>Integrations</h2>
            <table><tbody>
              <tr><td>AI model</td><td>{integ.llm ? <span className="badge ok">{integ.llm}</span> : <span className="badge warn">none: rule-based fallbacks</span>}</td></tr>
              <tr><td>Email delivery</td><td>{integ.deliversEmail ? <span className="badge ok">{integ.email}</span> : <span className="badge warn">dry-run (nothing is delivered)</span>}</td></tr>
              <tr><td>Web search</td><td>{integ.search ? <span className="badge ok">{integ.search}</span> : <span className="badge warn">off (leads need a website)</span>}</td></tr>
              <tr><td>Inbound replies</td><td>{integ.inbound ? <span className="badge ok">webhook ready</span> : <span className="badge warn">INBOUND_WEBHOOK_SECRET unset</span>}</td></tr>
              <tr><td>Lead source</td><td><span className="badge ok">NPPES registry</span></td></tr>
            </tbody></table>
            {integ.deliversEmail && integ.email !== "smtp" && (
              <div className="small" style={{ marginTop: 10 }}>
                <strong>Delivery &amp; bounce events:</strong> set your {integ.email} webhook to <code>{baseUrl()}/api/webhooks/email/{integ.email}</code> (delivered, bounced, complained). It is rejected unless signed; see the README for the matching secret variable.
              </div>
            )}
            {integ.email === "smtp" && <div className="small muted" style={{ marginTop: 10 }}>Plain SMTP cannot report delivery or bounces. Use Resend, SendGrid, Postmark or Mailgun for that.</div>}
            <details style={{ marginTop: 10 }}>
              <summary className="small muted">Supported providers (set the matching key in the server environment, then restart)</summary>
              <ul className="plain small">
                <li><strong>AI:</strong> {SUPPORTED_LLM_PROVIDERS.join(", ")}</li>
                <li><strong>Email:</strong> {SUPPORTED_EMAIL_PROVIDERS.join(", ")}</li>
                <li><strong>Search:</strong> {SUPPORTED_SEARCH_PROVIDERS.join(", ")}</li>
              </ul>
            </details>
          </div>
          <Suppressions items={sup} />
        </div>
      </div>
    </>
  );
}
