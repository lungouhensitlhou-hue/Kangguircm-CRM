import { getSettings, query, senderReady } from "@rcm/core";
import { SettingsForm, Suppressions } from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [s, sup] = await Promise.all([getSettings(), query<{ email: string; reason: string }>("SELECT email, reason FROM suppressions ORDER BY created_at DESC LIMIT 200")]);
  const ready = senderReady(s);
  const smtp = !!process.env.SMTP_URL;
  return (
    <>
      <div className="head"><div><h1>Settings</h1><div className="muted">Identity, guardrails and integrations</div></div></div>
      <div className={`notice ${ready.ok ? "ok" : "warn"}`}>{ready.ok ? "Sender identity is complete: drafts can be approved." : `Missing: ${ready.missing.join(", ")}.`}</div>
      <div className="grid g2">
        <SettingsForm initial={s} />
        <div className="grid" style={{ alignContent: "start" }}>
          <div className="card">
            <h2>Integrations</h2>
            <table><tbody>
              <tr><td>Claude API</td><td>{process.env.ANTHROPIC_API_KEY ? <span className="badge ok">configured (web)</span> : <span className="badge warn">not set on web; the worker needs it</span>}</td></tr>
              <tr><td>Email delivery</td><td>{smtp ? <span className="badge ok">SMTP</span> : <span className="badge warn">dry-run (nothing is delivered)</span>}</td></tr>
              <tr><td>Web search</td><td>{process.env.BRAVE_API_KEY ? <span className="badge ok">Brave</span> : <span className="badge warn">off (leads need a website)</span>}</td></tr>
              <tr><td>Inbound replies</td><td>{process.env.INBOUND_WEBHOOK_SECRET ? <span className="badge ok">webhook ready</span> : <span className="badge warn">INBOUND_WEBHOOK_SECRET unset</span>}</td></tr>
              <tr><td>Lead source</td><td><span className="badge ok">NPPES registry</span></td></tr>
            </tbody></table>
          </div>
          <Suppressions items={sup} />
        </div>
      </div>
    </>
  );
}
