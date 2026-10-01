import Link from "next/link";
import { costPerOutcome, funnel, outreachStats, replyTiming, weekly, type GroupBy } from "@rcm/core";

export const dynamic = "force-dynamic";
const GROUPS: [GroupBy, string][] = [["specialty", "Specialty"], ["template", "Template / variant"], ["step", "Sequence step"], ["state", "State"]];
const WINDOWS: [string, string][] = [["30", "30 days"], ["90", "90 days"], ["all", "All time"]];
const usd = (n: number | null) => (n === null ? "–" : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: n < 10 ? 2 : 0, maximumFractionDigits: 2 }));

export default async function Reports({ searchParams }: { searchParams: Promise<{ group?: string; days?: string }> }) {
  const sp = await searchParams;
  const group = (GROUPS.some(([k]) => k === sp.group) ? sp.group : "specialty") as GroupBy;
  const daysKey = WINDOWS.some(([k]) => k === sp.days) ? sp.days! : "90";
  const days = daysKey === "all" ? undefined : Number(daysKey);
  const [fun, rows, timing, cost, wk] = await Promise.all([funnel(), outreachStats({ groupBy: group, days }), replyTiming(days), costPerOutcome(days), weekly(8)]);
  const maxWeek = Math.max(1, ...wk.map((w) => w.sent));
  const href = (g: string, d: string) => `/reports?group=${g}&days=${d}`;
  return (
    <>
      <div className="head"><div><h1>Reports</h1><div className="muted">What is working, with honest uncertainty: small groups are marked, not ranked.</div></div></div>
      <div className="tabs">{WINDOWS.map(([k, l]) => <Link key={k} href={href(group, k)} className={daysKey === k ? "active" : ""}>{l}</Link>)}</div>

      <div className="card" style={{ marginBottom: 14 }} data-testid="funnel">
        <h2>Funnel</h2>
        {fun.map((s) => (
          <div key={s.key} style={{ display: "grid", gridTemplateColumns: "170px 1fr 60px 90px", gap: 10, alignItems: "center", marginBottom: 8 }}>
            <span>{s.label}</span>
            <div className="bar"><i style={{ width: `${Math.min(100, s.pctOfTotal)}%` }} /></div>
            <strong style={{ textAlign: "right" }}>{s.count}</strong>
            <span className="small muted">{s.pctOfPrev === null ? "" : `${s.pctOfPrev}% of prev`}</span>
          </div>
        ))}
        <div className="small muted">Each lead is counted at the furthest point it actually reached. Funnel is all-time.</div>
      </div>

      <div className="grid g3" style={{ marginBottom: 14 }}>
        <div className="card stat"><div className="n">{timing.medianHours === null ? "–" : timing.medianHours < 48 ? `${timing.medianHours}h` : `${Math.round(timing.medianHours / 24)}d`}</div><div className="l">Median time to reply ({timing.n} replies)</div></div>
        <div className="card stat"><div className="n">{usd(cost.spend)}</div><div className="l">AI spend · {usd(cost.perPositiveReply)} per positive reply</div></div>
        <div className="card stat"><div className="n">{usd(cost.perDeal)}</div><div className="l">AI spend per deal ({cost.deals} deal(s))</div></div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Outreach results</h2>
        <div className="tabs">{GROUPS.map(([k, l]) => <Link key={k} href={href(k, daysKey)} className={group === k ? "active" : ""}>{l}</Link>)}</div>
        <div className="tablewrap">
          <table data-testid="outreach-table">
            <thead><tr><th>{GROUPS.find(([k]) => k === group)![1]}</th><th>Sent</th><th>Delivered</th><th>Bounced</th><th>Replies</th><th>Positive</th><th>Reply rate</th><th>95% range</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ padding: 16 }}>No emails sent in this window yet.</td></tr>}
              {rows.map((r) => (
                <tr key={r.group}>
                  <td>{r.group}{!r.enough && <> <span className="badge warn" title="Fewer than 30 sends: too few to compare">few sends</span></>}</td>
                  <td>{r.sent}</td><td>{r.delivered}</td><td>{r.bounced}</td><td>{r.replies}</td><td>{r.positive}</td>
                  <td><strong>{r.replyRate}%</strong></td><td className="muted small">{r.ci[0]}–{r.ci[1]}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>Each reply counts for the email sent just before it. Out-of-office auto-replies are ignored. Delivered/bounced need your provider's webhook. If two groups' ranges overlap, the difference may be luck.</div>
      </div>

      <div className="card">
        <h2>Last 8 weeks</h2>
        <table><thead><tr><th>Week of</th><th>Sent</th><th style={{ width: "50%" }}></th><th>Replies</th><th>Bounced</th></tr></thead>
          <tbody>{wk.map((w) => <tr key={w.week}><td>{w.week}</td><td>{w.sent}</td><td><div className="bar"><i style={{ width: `${(w.sent / maxWeek) * 100}%` }} /></div></td><td>{w.replies}</td><td>{w.bounced}</td></tr>)}</tbody></table>
      </div>
    </>
  );
}
