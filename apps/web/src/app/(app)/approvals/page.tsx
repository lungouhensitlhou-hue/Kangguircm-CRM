import Link from "next/link";
import { getSettings, listMessages, senderReady } from "@rcm/core";
import { ApprovalCard } from "@/components/ApprovalCard";
import { StatusBadge } from "@/components/Badge";
import { ago } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Approvals() {
  const [drafts, recent, s] = await Promise.all([listMessages({ status: "draft" }), listMessages({ limit: 15 }), getSettings()]);
  const ready = senderReady(s);
  return (
    <>
      <div className="head"><div><h1>Approvals</h1><div className="muted">Nothing is sent until you approve it. Sends respect your window ({s.sendWindowStartHour}:00–{s.sendWindowEndHour}:00 {s.timezone}, weekdays) and daily cap ({s.dailySendCap}).</div></div></div>
      {!ready.ok && <div className="notice warn">Approving is disabled until you complete <Link href="/settings">Settings</Link>: {ready.missing.join(", ")}.</div>}
      {process.env.SMTP_URL ? null : <div className="notice warn">No <code>SMTP_URL</code> configured: approved emails are recorded as sent in <strong>dry-run</strong> mode and are not actually delivered.</div>}
      <div className="grid" style={{ marginBottom: 24 }}>
        {drafts.length === 0 && <div className="card muted">No drafts waiting. Ask the outreach agent to draft emails from a lead page or bulk from the Leads list.</div>}
        {drafts.map((d) => <ApprovalCard key={d.id} d={{ id: d.id, lead_id: d.lead_id, org_name: d.org_name, to_email: d.to_email!, contact_name: d.contact_name, step: d.step, subject: d.subject, body: d.body }} />)}
      </div>
      <div className="card">
        <h2>Recent email activity</h2>
        <table><tbody>
          {recent.filter((m) => m.status !== "draft").map((m) => (
            <tr key={m.id}><td><Link href={`/leads/${m.lead_id}`}>{m.org_name}</Link></td><td>{m.direction === "inbound" ? "↩ " : ""}{m.subject}</td><td><StatusBadge status={m.status} /></td><td className="muted small">{ago(m.sent_at ?? m.created_at)}</td></tr>
          ))}
        </tbody></table>
      </div>
    </>
  );
}
