import Link from "next/link";
import { STAGES, STAGE_LABELS } from "@rcm/core/types";
import { listLeads, listViews } from "@rcm/core";
import { SavedViews } from "@/components/SavedViews";
import { AddLeadPanel, BulkBar, DiscoverPanel, ImportPanel } from "@/components/LeadTools";
import { Badge } from "@/components/Badge";
import { scoreClass } from "@/lib/format";

export const dynamic = "force-dynamic";
type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function Leads({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = one(sp.q), stage = one(sp.stage), state = one(sp.state), specialty = one(sp.specialty), tag = one(sp.tag), sort = one(sp.sort) || "score";
  const page = Math.max(0, Number(one(sp.page) || 0));
  const [{ rows, total }, views] = await Promise.all([listLeads({ q, stage, state, specialty, tag, sort: sort as any, limit: 50, offset: page * 50 }), listViews()]);
  const qs = (over: Record<string, string>) => new URLSearchParams(Object.entries({ q, stage, state, specialty, tag, sort, ...over }).filter(([, v]) => v) as [string, string][]).toString();
  return (
    <>
      <div className="head"><div><h1>Leads</h1><div className="muted">{total} lead{total === 1 ? "" : "s"}</div></div></div>
      <form className="card row" style={{ marginBottom: 14 }} method="get">
        <div className="field"><label htmlFor="q">Search</label><input id="q" name="q" defaultValue={q} placeholder="Name, city, specialty" /></div>
        <div className="field"><label htmlFor="stage">Stage</label><select id="stage" name="stage" defaultValue={stage}><option value="">All</option>{STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}</select></div>
        <div className="field" style={{ maxWidth: 90 }}><label htmlFor="state">State</label><input id="state" name="state" maxLength={2} defaultValue={state} /></div>
        <div className="field"><label htmlFor="specialty">Specialty</label><input id="specialty" name="specialty" defaultValue={specialty} /></div>
        <div className="field" style={{ maxWidth: 130 }}><label htmlFor="tag">Tag</label><input id="tag" name="tag" defaultValue={tag} placeholder="pilot" /></div>
        <div className="field"><label htmlFor="sort">Sort</label><select id="sort" name="sort" defaultValue={sort}><option value="score">Best score</option><option value="recent">Newest</option><option value="name">Name</option></select></div>
        <div className="field fit"><button className="primary">Filter</button></div>
      </form>
      <SavedViews views={views.map((v) => ({ id: v.id, name: v.name, filters: v.filters }))} current={{ q, stage, state, specialty, tag }} exportHref={`/api/export/leads?${new URLSearchParams(Object.entries({ q, stage, state, specialty, tag, sort }).filter(([, v]) => v) as [string, string][]).toString()}`} />
      <BulkBar ids={rows.map((r) => r.id)} />
      <div className="card tablewrap" style={{ padding: 0, marginBottom: 14 }}>
        <table>
          <thead><tr><th>Practice</th><th>Specialty</th><th>Location</th><th>Stage</th><th>Score</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 20 }}>No leads match. Discover, import or add some below.</td></tr>}
            {rows.map((l) => (
              <tr key={l.id}>
                <td><Link href={`/leads/${l.id}`}>{l.org.name}</Link>{l.tags?.length > 0 && <> {l.tags.map((t) => <Link key={t} className="badge" href={`/leads?tag=${t}`}>{t}</Link>)}</>}{l.org.website && <div className="small muted">{l.org.website.replace(/^https?:\/\//, "")}</div>}</td>
                <td className="muted">{l.org.specialty ?? "–"}</td>
                <td className="muted">{[l.org.city, l.org.state].filter(Boolean).join(", ") || "–"}</td>
                <td><Badge kind={l.stage === "replied" || l.stage === "meeting" || l.stage === "won" ? "ok" : l.stage === "lost" || l.stage === "disqualified" ? "bad" : "brand"}>{STAGE_LABELS[l.stage]}</Badge></td>
                <td><span className={`score ${scoreClass(l.score)}`}>{l.score}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginBottom: 20 }}>
        {page > 0 && <Link className="btn fit" href={`/leads?${qs({ page: String(page - 1) })}`}>← Previous</Link>}
        {(page + 1) * 50 < total && <Link className="btn fit" href={`/leads?${qs({ page: String(page + 1) })}`}>Next →</Link>}
      </div>
      <div className="grid g2">
        <DiscoverPanel />
        <ImportPanel />
      </div>
      <div style={{ marginTop: 14 }}><AddLeadPanel /></div>
    </>
  );
}
