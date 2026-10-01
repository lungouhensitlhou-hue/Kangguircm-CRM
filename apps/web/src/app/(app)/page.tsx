import Link from "next/link";
import { STAGES, STAGE_LABELS } from "@rcm/core/types";
import { dealStats, listTasks, validateConfig, workerStatus, integrationStatus, listRuns, pipelineStats, query, getSettings, senderReady } from "@rcm/core";
import { StatusBadge } from "@/components/Badge";
import { ago } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const [stats, runs, top, settings, replies] = await Promise.all([
    pipelineStats(),
    listRuns({ limit: 8 }),
    query("SELECT l.id, l.score, l.stage, o.name, o.specialty, o.city, o.state FROM leads l JOIN organizations o ON o.id = l.organization_id WHERE l.stage IN ('researched','outreach_drafted') ORDER BY l.score DESC LIMIT 6"),
    getSettings(),
    query<any>("SELECT m.id, m.lead_id, m.classification, m.meta, m.created_at, o.name FROM messages m JOIN leads l ON l.id = m.lead_id JOIN organizations o ON o.id = l.organization_id WHERE m.direction = 'inbound' ORDER BY m.created_at DESC LIMIT 6"),
  ]);
  const ready = senderReady(settings);
  const integ = integrationStatus();
  const [worker, dueTasks, deals] = await Promise.all([workerStatus(), listTasks({ bucket: "all", limit: 6 }), dealStats()]);
  const blocking = validateConfig().filter((i) => i.level === "error");
  const max = Math.max(1, ...Object.values(stats.byStage));
  return (
    <>
      <div className="head"><div><h1>Dashboard</h1><div className="muted">Your outreach engine at a glance</div></div></div>
      {!worker.alive && <div className="notice err" role="alert"><strong>The background worker is not running.</strong> Agents (discovery, research, drafting, sending) cannot work{worker.queued ? `, and ${worker.queued} job(s) are waiting` : ""}. Start the worker process with the same database (docker compose: the <code>worker</code> service). See <Link href="/settings">Settings → Connection test</Link>.</div>}
      {blocking.length > 0 && <div className="notice err" role="alert"><strong>{blocking.length} configuration problem(s) will break features:</strong> {blocking.map((b) => b.key).join(", ")}. Details and fixes are in <Link href="/settings">Settings</Link>.</div>}
      {!ready.ok && <div className="notice warn">Before any email can be approved, complete <Link href="/settings">Settings</Link>: {ready.missing.join(", ")}. (CAN-SPAM requires a physical address and sender identity.)</div>}
      {!integ.llm && <div className="notice warn">No AI provider key found: research and drafting use rule-based fallbacks. Add any supported key (Anthropic, OpenAI, Gemini, Groq, Mistral, DeepSeek, OpenRouter, Ollama…) to the worker's environment. See Settings.</div>}
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <div className="card stat"><div className="n">{stats.total}</div><div className="l">Total leads</div></div>
        <div className="card stat"><div className="n">{stats.messages.drafts}</div><div className="l"><Link href="/approvals">Drafts to approve</Link></div></div>
        <div className="card stat"><div className="n">{stats.messages.sent}</div><div className="l">Emails sent</div><div className="small muted" style={{ marginTop: 4 }}>{stats.email.delivered} delivered · {stats.email.bounced} bounced{stats.email.opened ? ` · ${stats.email.opened} opened (approx.)` : ""}{stats.email.complaints ? ` · ${stats.email.complaints} complaint(s)` : ""}</div></div>
        <div className="card stat"><div className="n">{stats.replyRate}%</div><div className="l">Reply rate ({stats.messages.replies} replies)</div></div>
      </div>
      <div className="grid g2">
        <div className="card">
          <h2>Pipeline</h2>
          {STAGES.map((s) => (
            <div key={s} style={{ display: "grid", gridTemplateColumns: "120px 1fr 36px", gap: 10, alignItems: "center", marginBottom: 8 }}>
              <Link href={`/leads?stage=${s}`}>{STAGE_LABELS[s]}</Link>
              <div className="bar"><i style={{ width: `${(stats.byStage[s] / max) * 100}%` }} /></div>
              <span className="muted" style={{ textAlign: "right" }}>{stats.byStage[s]}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>Agent activity</h2>
          <div className="small muted" style={{ marginBottom: 8 }}>{stats.runs.running} running · {stats.runs.queued} queued · {stats.runs.failed24} failed (24h) · ${stats.runs.cost.toFixed(2)} AI spend (30d)</div>
          <ul className="plain">
            {runs.length === 0 && <li className="muted">No runs yet. Discover leads or ask an agent to get started.</li>}
            {runs.map((r) => (
              <li key={r.id}><Link href={`/runs/${r.id}`}>{r.kind}</Link> <StatusBadge status={r.status} /> <span className="muted small"> {ago(r.created_at)}</span></li>
            ))}
          </ul>
        </div>
      </div>
      <div className="grid g2" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>Next tasks</h2>
          {dueTasks.length === 0 ? <div className="muted">No open tasks. <Link href="/tasks">Add one</Link>.</div> : <ul className="plain">{dueTasks.map((t) => <li key={t.id}>{t.title}{t.org_name && t.lead_id ? <> · <Link href={`/leads/${t.lead_id}`}>{t.org_name}</Link></> : null}<div className="small muted">due {new Date(t.due_at).toLocaleDateString()}</div></li>)}</ul>}
          <div className="small" style={{ marginTop: 8 }}><Link href="/tasks">All tasks →</Link></div>
        </div>
        <div className="card">
          <h2>Deals</h2>
          <div className="small muted">Open pipeline</div><div style={{ fontSize: 22, fontWeight: 700 }}>{deals.open.value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}</div>
          <div className="small muted">{deals.open.count} open · {deals.won.count} won ({deals.won.value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}){deals.winRate !== null ? ` · ${deals.winRate}% win rate` : ""}</div>
          <div className="small" style={{ marginTop: 8 }}><Link href="/deals">All deals →</Link></div>
        </div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h2>Recent replies</h2>
        {replies.length === 0 ? <div className="muted">No replies yet.</div> : (
          <ul className="plain">{replies.map((r: any) => (
            <li key={r.id}><Link href={`/leads/${r.lead_id}`}>{r.name}</Link> <span className={`badge ${r.classification === "interested" || r.classification === "question" || r.classification === "referral" ? "ok" : r.classification === "not_interested" ? "bad" : "warn"}`}>{(r.classification ?? "new").replace("_", " ")}</span> <span className="muted small">{r.meta?.summary ?? ""} · {ago(r.created_at)}</span></li>
          ))}</ul>
        )}
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h2>Best researched leads</h2>
        {top.length === 0 ? <div className="muted">Nothing researched yet. Head to <Link href="/leads">Leads</Link> to discover or import some.</div> : (
          <table><tbody>{top.map((l: any) => (
            <tr key={l.id}><td><Link href={`/leads/${l.id}`}>{l.name}</Link></td><td className="muted">{l.specialty ?? "–"}</td><td className="muted">{l.city}, {l.state}</td><td><span className={`score ${l.score >= 60 ? "s-hi" : "s-mid"}`}>{l.score}</span></td></tr>
          ))}</tbody></table>
        )}
      </div>
    </>
  );
}
