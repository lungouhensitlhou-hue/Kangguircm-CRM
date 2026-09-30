import Link from "next/link";
import { notFound } from "next/navigation";
import { getRun, query } from "@rcm/core";
import { StatusBadge } from "@/components/Badge";
import { RunStream } from "@/components/RunStream";
import { CancelButton } from "@/components/CancelButton";
import { ago } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const run = await getRun(id);
  if (!run) notFound();
  const children = await query<any>("SELECT id, kind, status FROM agent_runs WHERE parent_id = $1 ORDER BY created_at LIMIT 30", [id]);
  const lead = run.lead_id ? await query<any>("SELECT o.name FROM leads l JOIN organizations o ON o.id = l.organization_id WHERE l.id = $1", [run.lead_id]) : [];
  return (
    <>
      <div className="head">
        <div>
          <div className="small"><Link href="/runs">← Runs</Link></div>
          <h1>{run.kind} run <StatusBadge status={run.status} /></h1>
          <div className="muted small">Started by {run.created_by} · {ago(run.created_at)} · attempt {run.attempts}/{run.max_attempts}{lead[0] ? <> · <Link href={`/leads/${run.lead_id}`}>{lead[0].name}</Link></> : null}</div>
        </div>
        {(run.status === "queued" || run.status === "running") && <CancelButton runId={run.id} />}
      </div>
      {run.error && <div className="notice err">{run.error}</div>}
      <div className="grid g2">
        <div className="card"><h2>Live log</h2><RunStream runId={run.id} initialStatus={run.status} /></div>
        <div className="grid" style={{ alignContent: "start" }}>
          <div className="card"><h2>Input</h2><pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(run.input, null, 2)}</pre></div>
          {run.output && <div className="card" data-testid="run-output"><h2>Output</h2><pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(run.output, null, 2)}</pre></div>}
          {children.length > 0 && <div className="card"><h2>Spawned runs</h2><ul className="plain">{children.map((c: any) => <li key={c.id}><Link href={`/runs/${c.id}`}>{c.kind}</Link> <StatusBadge status={c.status} /></li>)}</ul></div>}
        </div>
      </div>
    </>
  );
}
