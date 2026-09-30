import Link from "next/link";
import { STAGES, STAGE_LABELS } from "@rcm/core/types";
import { integrationStatus, listRuns, pipelineStats, query, getSettings, senderReady } from "@rcm/core";
import { StatusBadge } from "@/components/Badge";
import { ago } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const [stats, runs, top, settings] = await Promise.all([
    pipelineStats(),
    listRuns({ limit: 8 }),
    query("SELECT l.id, l.score, l.stage, o.name, o.specialty, o.city, o.state FROM leads l JOIN organizations o ON o.id = l.organization_id WHERE l.stage IN ('researched','outreach_drafted') ORDER BY l.score DESC LIMIT 6"),
    getSettings(),
  ]);
  const ready = senderReady(settings);
  const integ = integrationStatus();
  const max = Math.max(1, ...Object.values(stats.byStage));
  return (
    <>
      <div className="head"><div><h1>Dashboard</h1><div className="muted">Your outreach engine at a glance</div></div></div>
      {!ready.ok && <div className="notice warn">Before any email can be approved, complete <Link href="/settings">Settings</Link>: {ready.missing.join(", ")}. (CAN-SPAM requires a physical address and sender identity.)</div>}
      {!integ.llm && <div className="notice warn">No AI provider key found: research and drafting use rule-based fallbacks. Add any supported key (Anthropic, OpenAI, Gemini, Groq, Mistral, DeepSeek, OpenRouter, Ollama…) to the worker's environment. See Settings.</div>}
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <div className="card stat"><div className="n">{stats.total}</div><div className="l">Total leads</div></div>
        <div className="card stat"><div className="n">{stats.messages.drafts}</div><div className="l"><Link href="/approvals">Drafts to approve</Link></div></div>
        <div className="card stat"><div className="n">{stats.messages.sent}</div><div className="l">Emails sent</div></div>
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
