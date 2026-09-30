"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { STAGES, STAGE_LABELS, type Stage } from "@rcm/core/types";
import { api, useAction } from "./useApi";

export function LeadActions({ leadId, stage, notes }: { leadId: string; stage: Stage; notes: string }) {
  const router = useRouter();
  const a = useAction();
  const [text, setText] = useState(notes);
  const go = async (action: string) => {
    const r = await a.run(() => api<{ runId: string }>(`/api/leads/${leadId}/actions`, "POST", { action }));
    if (r) router.push(`/runs/${r.runId}`);
  };
  return (
    <div className="card">
      <h2>Actions</h2>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      {a.ok && <div className="notice ok">{a.ok}</div>}
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="fit primary" disabled={a.busy} onClick={() => go("research")}>Research this lead</button>
        <button className="fit" disabled={a.busy} onClick={() => go("research_and_draft")}>Research + draft email</button>
        <button className="fit" disabled={a.busy} onClick={() => go("draft_outreach")}>Draft email now</button>
      </div>
      <div className="field">
        <label htmlFor="stage">Pipeline stage</label>
        <select id="stage" value={stage} disabled={a.busy} onChange={(e) => a.run(() => api(`/api/leads/${leadId}`, "PATCH", { stage: e.target.value }), "Stage updated.")}>
          {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="notes">Notes</label>
        <textarea id="notes" value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 90 }} />
      </div>
      <button disabled={a.busy || text === notes} onClick={() => a.run(() => api(`/api/leads/${leadId}`, "PATCH", { notes: text }), "Notes saved.")}>Save notes</button>
    </div>
  );
}

export function AddContact({ leadId }: { leadId: string }) {
  const a = useAction();
  const [f, setF] = useState({ full_name: "", title: "", email: "" });
  return (
    <form onSubmit={async (e) => { e.preventDefault(); await a.run(async () => { await api(`/api/leads/${leadId}/contacts`, "POST", { ...f, is_decision_maker: /manager|director|owner|administrator|ceo|coo|cfo|partner/i.test(f.title) }); setF({ full_name: "", title: "", email: "" }); }); }}>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      <div className="row">
        <div className="field"><label htmlFor="c-name">Name</label><input id="c-name" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></div>
        <div className="field"><label htmlFor="c-title">Title</label><input id="c-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <div className="field"><label htmlFor="c-email">Email</label><input id="c-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        <div className="field fit"><button disabled={a.busy}>Add contact</button></div>
      </div>
    </form>
  );
}
