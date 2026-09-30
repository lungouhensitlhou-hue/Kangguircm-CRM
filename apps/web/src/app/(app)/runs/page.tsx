import Link from "next/link";
import { listRuns } from "@rcm/core";
import { StatusBadge } from "@/components/Badge";
import { SmokeButton } from "@/components/SmokeButton";
import { ago } from "@/lib/format";

export const dynamic = "force-dynamic";
const STATUSES = ["", "queued", "running", "succeeded", "failed", "cancelled"];

export default async function Runs({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const runs = await listRuns({ limit: 100, status: status || undefined });
  return (
    <>
      <div className="head"><div><h1>Agent runs</h1><div className="muted">Every agent action is a durable job with a live event log.</div></div><SmokeButton /></div>
      <div className="tabs">{STATUSES.map((s) => <Link key={s} href={s ? `/runs?status=${s}` : "/runs"} className={(status ?? "") === s ? "active" : ""}>{s || "all"}</Link>)}</div>
      <div className="card tablewrap" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Agent</th><th>Status</th><th>Started by</th><th>Created</th><th>Tokens</th><th>Cost</th></tr></thead>
          <tbody>
            {runs.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 20 }}>No runs.</td></tr>}
            {runs.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/runs/${r.id}`}>{r.kind}</Link></td>
                <td><StatusBadge status={r.status} />{r.attempts > 1 && <span className="small muted"> attempt {r.attempts}</span>}</td>
                <td className="muted">{r.created_by}</td><td className="muted">{ago(r.created_at)}</td>
                <td className="muted">{r.tokens_in + r.tokens_out || "–"}</td><td className="muted">{Number(r.cost_usd) ? `$${Number(r.cost_usd).toFixed(3)}` : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
