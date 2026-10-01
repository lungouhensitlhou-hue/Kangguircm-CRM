"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, useAction } from "./useApi";

export function DiscoverPanel() {
  const router = useRouter();
  const a = useAction();
  const [states, setStates] = useState("TX");
  const [taxonomy, setTaxonomy] = useState("");
  const [limit, setLimit] = useState(50);
  const [auto, setAuto] = useState(true);
  const [primaryOnly, setPrimaryOnly] = useState(true);
  return (
    <form className="card" onSubmit={async (e) => {
      e.preventDefault();
      const r = await a.run(() => api<{ runId: string }>("/api/discover", "POST", { states: states.split(/[ ,]+/).filter(Boolean).map((s) => s.toUpperCase()), taxonomy: taxonomy || undefined, limit: Number(limit), autoResearch: auto, primaryOnly }));
      if (r) router.push(`/runs/${r.runId}`);
    }}>
      <h2>Discover facilities (NPPES registry)</h2>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      <div className="row">
        <div className="field"><label htmlFor="d-states">States (comma-separated)</label><input id="d-states" value={states} onChange={(e) => setStates(e.target.value)} placeholder="TX, FL" /></div>
        <div className="field"><label htmlFor="d-tax">Specialty / taxonomy</label><input id="d-tax" value={taxonomy} onChange={(e) => setTaxonomy(e.target.value)} placeholder="Orthopaedic, Cardiovascular, Urgent Care…" required /></div>
        <div className="field fit" style={{ maxWidth: 100 }}><label htmlFor="d-limit">Limit</label><input id="d-limit" type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></div>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400, marginBottom: 12 }}><input type="checkbox" style={{ width: "auto" }} checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Automatically research the top 25 new leads</label>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400, marginBottom: 12 }}><input type="checkbox" style={{ width: "auto" }} checked={primaryOnly} onChange={(e) => setPrimaryOnly(e.target.checked)} /> Primary specialty only (the registry also matches secondary specialties)</label>
      <button className="primary" disabled={a.busy}>{a.busy ? "Starting…" : "Start discovery run"}</button>
    </form>
  );
}

export function ImportPanel() {
  const a = useAction();
  const [csv, setCsv] = useState("");
  return (
    <div className="card">
      <h2>Import CSV</h2>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      {a.ok && <div className="notice ok">{a.ok}</div>}
      <div className="small muted" style={{ marginBottom: 8 }}>Columns: name, npi, specialty, city, state, zip, phone, website, contact_name, contact_email, title</div>
      <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} style={{ marginBottom: 8 }} />
      <textarea aria-label="CSV text" placeholder="…or paste CSV here" value={csv} onChange={(e) => setCsv(e.target.value)} style={{ minHeight: 70, marginBottom: 8 }} />
      <button className="primary" disabled={a.busy || !csv.trim()} onClick={() => a.run(async () => {
        const res = await fetch("/api/leads/import", { method: "POST", headers: { "content-type": "text/csv" }, body: csv });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error);
        setCsv("");
        a.setOk(`Imported: ${j.created} new, ${j.existing} existing, ${j.skipped} skipped, ${j.contacts} contact(s).`);
      })}>Import</button>
    </div>
  );
}

export function AddLeadPanel() {
  const a = useAction();
  const [f, setF] = useState({ name: "", specialty: "", city: "", state: "", website: "", contactName: "", contactTitle: "", contactEmail: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="card" onSubmit={async (e) => {
      e.preventDefault();
      await a.run(async () => { await api("/api/leads", "POST", f); setF({ name: "", specialty: "", city: "", state: "", website: "", contactName: "", contactTitle: "", contactEmail: "" }); }, "Lead added.");
    }}>
      <h2>Add a lead</h2>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      {a.ok && <div className="notice ok">{a.ok}</div>}
      <div className="row">
        <div className="field"><label htmlFor="a-name">Practice / facility</label><input id="a-name" required value={f.name} onChange={set("name")} /></div>
        <div className="field"><label htmlFor="a-spec">Specialty</label><input id="a-spec" value={f.specialty} onChange={set("specialty")} /></div>
      </div>
      <div className="row">
        <div className="field"><label htmlFor="a-city">City</label><input id="a-city" value={f.city} onChange={set("city")} /></div>
        <div className="field" style={{ maxWidth: 80 }}><label htmlFor="a-state">State</label><input id="a-state" maxLength={2} value={f.state} onChange={set("state")} /></div>
        <div className="field"><label htmlFor="a-web">Website</label><input id="a-web" value={f.website} onChange={set("website")} /></div>
      </div>
      <div className="row">
        <div className="field"><label htmlFor="a-cn">Contact name</label><input id="a-cn" value={f.contactName} onChange={set("contactName")} /></div>
        <div className="field"><label htmlFor="a-ct">Contact title</label><input id="a-ct" value={f.contactTitle} onChange={set("contactTitle")} /></div>
        <div className="field"><label htmlFor="a-ce">Contact email</label><input id="a-ce" type="email" value={f.contactEmail} onChange={set("contactEmail")} /></div>
      </div>
      <button className="primary" disabled={a.busy}>Add lead</button>
    </form>
  );
}

export function BulkBar({ ids }: { ids: string[] }) {
  const a = useAction();
  const [tag, setTag] = useState("");
  return (
    <div className="row" style={{ marginBottom: 10, alignItems: "center" }}>
      <span className="muted fit">Bulk on the {ids.length} leads shown:</span>
      <button className="fit sm" disabled={a.busy || !ids.length} onClick={() => a.run(() => api("/api/leads/bulk", "POST", { ids, action: "research" }), "Research queued for all shown leads.")}>Research all</button>
      <button className="fit sm" disabled={a.busy || !ids.length} onClick={() => a.run(() => api("/api/leads/bulk", "POST", { ids, action: "find_contacts" }), "Contact finder queued for all shown leads.")}>Find contacts for all</button>
      <button className="fit sm" disabled={a.busy || !ids.length} onClick={() => a.run(() => api("/api/leads/bulk", "POST", { ids, action: "draft_outreach" }), "Drafting queued (drafts land in Approvals).")}>Draft outreach for all</button>
      <input aria-label="Tag" className="fit" style={{ maxWidth: 120 }} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="tag" />
      <button className="fit sm" disabled={a.busy || !ids.length || !tag.trim()} onClick={() => a.run(() => api("/api/leads/bulk", "POST", { ids, action: "tag", tag }), "Tagged.")}>Add tag</button>
      <button className="fit sm" disabled={a.busy || !ids.length || !tag.trim()} onClick={() => a.run(() => api("/api/leads/bulk", "POST", { ids, action: "untag", tag }), "Tag removed.")}>Remove tag</button>
      {a.ok && <span className="badge ok fit">{a.ok}</span>}{a.error && <span className="badge bad fit">{a.error}</span>}
    </div>
  );
}
