import Link from "next/link";
import { dealStats, listDeals } from "@rcm/core";
import { DealEditor } from "@/components/DealEditor";
import { StatusBadge } from "@/components/Badge";

export const dynamic = "force-dynamic";
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default async function Deals() {
  const [deals, st] = await Promise.all([listDeals(), dealStats()]);
  return (
    <>
      <div className="head"><div><h1>Deals</h1><div className="muted">Revenue pipeline. A lead moving to Meeting opens a deal; Won / Lost close it and move the lead.</div></div></div>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <div className="card stat"><div className="n" data-testid="open-value">{usd(st.open.value)}</div><div className="l">Open pipeline · {st.open.count} deal(s)</div></div>
        <div className="card stat"><div className="n">{usd(st.won.value)}</div><div className="l">Won · {st.won.count}</div></div>
        <div className="card stat"><div className="n">{st.winRate === null ? "–" : `${st.winRate}%`}</div><div className="l">Win rate ({st.won.count} won, {st.lost.count} lost)</div></div>
        <div className="card stat"><div className="n">{st.won.count ? `${st.avgDaysToWin}d` : "–"}</div><div className="l">Average days to win</div></div>
      </div>
      {deals.length === 0 && <div className="card muted">No deals yet. Move a lead to <strong>Meeting</strong> on the pipeline, or create one from a lead page.</div>}
      <div className="grid">
        {deals.map((d) => (
          <div key={d.id} className="card" data-testid="deal">
            <div className="head" style={{ marginBottom: 6 }}><div><Link href={`/leads/${d.lead_id}`}><strong>{d.org_name}</strong></Link> <StatusBadge status={d.status} /><div className="small muted">{d.name}{d.source === "auto" ? " · opened automatically" : ""}</div></div></div>
            <DealEditor deal={{ id: d.id, lead_id: d.lead_id, name: d.name, value_usd: d.value_usd, status: d.status, expected_close: d.expected_close, notes: d.notes }} />
          </div>
        ))}
      </div>
    </>
  );
}
