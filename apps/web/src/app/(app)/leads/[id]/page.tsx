import Link from "next/link";
import { notFound } from "next/navigation";
import { STAGE_LABELS } from "@rcm/core/types";
import { getContacts, getLead, query, queryOne, isSuppressed } from "@rcm/core";
import { AddContact, LeadActions } from "@/components/LeadActions";
import { Badge, StatusBadge } from "@/components/Badge";
import { ago, scoreClass } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lead = await getLead(id);
  if (!lead) notFound();
  const [contacts, profile, messages, runs] = await Promise.all([
    getContacts(lead.organization_id),
    queryOne<any>("SELECT * FROM research_profiles WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1", [lead.id]),
    query<any>("SELECT * FROM messages WHERE lead_id = $1 ORDER BY created_at", [lead.id]),
    query<any>("SELECT id, kind, status, created_at FROM agent_runs WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 10", [lead.id]),
  ]);
  const suppressed = new Set<string>();
  for (const c of contacts) if (c.email && (await isSuppressed(c.email))) suppressed.add(c.email);
  const o = lead.org;
  return (
    <>
      <div className="head">
        <div>
          <div className="small"><Link href="/leads">← Leads</Link></div>
          <h1>{o.name}</h1>
          <div className="muted">{[o.specialty, [o.city, o.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}{o.npi ? ` · NPI ${o.npi}` : ""}</div>
        </div>
        <div><Badge kind="brand">{STAGE_LABELS[lead.stage]}</Badge> <span className={`score ${scoreClass(lead.score)}`} title="Lead score">{lead.score}</span></div>
      </div>
      <div className="grid g2">
        <div className="grid" style={{ alignContent: "start" }}>
          <div className="card">
            <h2>Organization</h2>
            <table><tbody>
              <tr><td className="muted">Website</td><td>{o.website ? <a href={o.website} target="_blank" rel="noreferrer noopener">{o.website}</a> : "–"}</td></tr>
              <tr><td className="muted">Phone</td><td>{o.phone ?? "–"}</td></tr>
              <tr><td className="muted">Address</td><td>{[o.address, o.city, o.state, o.zip].filter(Boolean).join(", ") || "–"}</td></tr>
              <tr><td className="muted">EHR</td><td>{o.ehr ?? "unknown"}</td></tr>
              <tr><td className="muted">Size</td><td>{o.size_estimate ?? "unknown"}</td></tr>
            </tbody></table>
            {lead.score_reasons.length > 0 && <details style={{ marginTop: 8 }}><summary className="small muted">Why this score?</summary><ul className="plain small">{lead.score_reasons.map((r) => <li key={r}>{r}</li>)}</ul></details>}
          </div>
          <div className="card">
            <h2>Contacts</h2>
            {contacts.length === 0 ? <div className="muted" style={{ marginBottom: 10 }}>No contacts yet. Run research or add one.</div> : (
              <table><tbody>{contacts.map((c) => (
                <tr key={c.id}>
                  <td>{c.full_name ?? <span className="muted">(shared inbox)</span>}{c.title && <div className="small muted">{c.title}</div>}{c.phone && <div className="small muted">{c.phone}</div>}</td>
                  <td>
                    {c.email ?? <span className="muted">no email yet</span>}
                    {c.email && suppressed.has(c.email) && <> <Badge kind="bad">do not contact</Badge></>}
                    {c.email && (
                      <div style={{ marginTop: 2 }}>
                        <Badge kind={c.email_status === "verified" ? "ok" : c.email_status === "invalid" || c.email_status === "bounced" ? "bad" : c.email_status === "risky" ? "warn" : ""}>{c.email_status}</Badge>{" "}
                        <Badge kind={c.email_source === "pattern" ? "warn" : "info"}>{c.email_source === "pattern" ? `guessed · ${c.email_confidence}%` : "published"}</Badge>
                      </div>
                    )}
                  </td>
                  <td>{c.is_decision_maker && <Badge kind="ok">decision maker</Badge>}<div className="small muted">{c.source}</div></td>
                </tr>
              ))}</tbody></table>
            )}
            <div style={{ marginTop: 12 }}><AddContact leadId={lead.id} /></div>
          </div>
          <LeadActions leadId={lead.id} stage={lead.stage} notes={lead.notes} />
        </div>
        <div className="grid" style={{ alignContent: "start" }}>
          <div className="card">
            <h2>Research profile {profile && <Badge kind={profile.method === "llm" ? "brand" : ""}>{profile.method === "llm" ? "AI" : "rule-based"} · confidence {Math.round(profile.confidence * 100)}%</Badge>}</h2>
            {!profile ? <div className="muted">Not researched yet.</div> : (
              <>
                <p style={{ marginTop: 0 }}>{profile.summary}</p>
                {profile.pain_points.length > 0 && <><h3>Billing signals</h3><ul className="plain">{profile.pain_points.map((p: any, i: number) => <li key={i}><strong>{p.point}</strong><div className="small muted">“{p.evidence}”</div></li>)}</ul></>}
                {profile.sources.length > 0 && <><h3 style={{ marginTop: 12 }}>Sources</h3><ul className="plain small">{profile.sources.map((s: any) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer noopener">{s.title || s.url}</a></li>)}</ul></>}
              </>
            )}
          </div>
          <div className="card">
            <h2>Emails</h2>
            {messages.length === 0 ? <div className="muted">No emails yet.</div> : messages.map((m) => (
              <div key={m.id} style={{ marginBottom: 14 }}>
                <div><StatusBadge status={m.status} />{m.classification && <> <Badge kind={m.classification === "interested" || m.classification === "question" || m.classification === "referral" ? "ok" : m.classification === "not_interested" ? "bad" : "warn"}>{m.classification.replace("_", " ")}</Badge></>} <strong>{m.direction === "inbound" ? "Reply: " : `Step ${m.step}: `}{m.subject}</strong></div>
                {m.direction === "outbound" && m.status === "sent" && (
                  <div style={{ margin: "2px 0" }}>
                    {m.bounced_at ? <Badge kind="bad">bounced</Badge> : m.delivered_at ? <Badge kind="ok">delivered</Badge> : null}
                    {m.open_count > 0 && <> <Badge kind="info" >opened ×{m.open_count} (approx.)</Badge></>}
                  </div>
                )}
                <div className="small muted">{m.direction === "inbound" ? "from" : "to"} {m.to_email} · {ago(m.sent_at ?? m.created_at)}{m.provider ? ` · via ${m.provider}` : ""}{m.error ? ` · ${m.error}` : ""}</div>
                {m.meta?.summary && <div className="small">{m.meta.summary}</div>}
                <details><summary className="small">Show</summary><div className="email">{m.body}</div></details>
              </div>
            ))}
            {messages.some((m: any) => m.status === "draft") && <Link className="btn" href="/approvals">Review drafts →</Link>}
          </div>
          <div className="card">
            <h2>Agent runs</h2>
            <ul className="plain">{runs.length === 0 && <li className="muted">None</li>}{runs.map((r) => <li key={r.id}><Link href={`/runs/${r.id}`}>{r.kind}</Link> <StatusBadge status={r.status} /> <span className="muted small">{ago(r.created_at)}</span></li>)}</ul>
          </div>
        </div>
      </div>
    </>
  );
}
