"use client";
import { useState } from "react";
import { api, useAction } from "./useApi";

export interface Step { delayDays: number; templateIds?: string[] }
export interface SeqItem { id: string; name: string; steps: Step[]; is_default: boolean }
export interface Tpl { id: string; name: string }

export function SequenceEditor({ seq, templates }: { seq?: SeqItem; templates: Tpl[] }) {
  const a = useAction();
  const [name, setName] = useState(seq?.name ?? "");
  const [steps, setSteps] = useState<Step[]>(seq?.steps ?? [{ delayDays: 0 }, { delayDays: 3 }, { delayDays: 7 }]);
  const id = seq?.id ?? "new";
  const set = (i: number, patch: Partial<Step>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const save = () => a.run(async () => {
    if (seq) await api(`/api/sequences/${seq.id}`, "PATCH", { name, steps });
    else { await api("/api/sequences", "POST", { name, steps }); setName(""); }
  }, seq ? "Saved." : "Sequence created.");
  return (
    <div className="card" data-testid={seq ? "sequence" : "new-sequence"}>
      <h2>{seq ? seq.name : "New sequence"} {seq?.is_default && <span className="badge brand">default</span>}</h2>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      {a.ok && <div className="notice ok" role="status">{a.ok}</div>}
      <div className="field"><label htmlFor={`sn-${id}`}>Name</label><input id={`sn-${id}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Standard 3-touch" /></div>
      {steps.map((s, i) => (
        <div key={i} className="row" style={{ alignItems: "flex-end", marginBottom: 8 }}>
          <div className="field fit"><strong>Step {i + 1}</strong><div className="small muted">{i === 0 ? "first email" : "follow-up"}</div></div>
          <div className="field" style={{ maxWidth: 130 }}><label htmlFor={`sd-${id}-${i}`}>{i === 0 ? "Send" : "Wait (days)"}</label><input id={`sd-${id}-${i}`} type="number" min={i === 0 ? 0 : 1} max={60} value={s.delayDays} disabled={i === 0} onChange={(e) => set(i, { delayDays: Number(e.target.value) })} /></div>
          <div className="field"><label htmlFor={`st-${id}-${i}`}>Template A</label>
            <select id={`st-${id}-${i}`} value={s.templateIds?.[0] ?? ""} onChange={(e) => set(i, { templateIds: [e.target.value, ...(s.templateIds?.slice(1) ?? [])].filter(Boolean) })}>
              <option value="">AI-written</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></div>
          <div className="field"><label htmlFor={`sb-${id}-${i}`}>Template B (A/B test)</label>
            <select id={`sb-${id}-${i}`} value={s.templateIds?.[1] ?? ""} disabled={!s.templateIds?.[0]} onChange={(e) => set(i, { templateIds: [s.templateIds![0], e.target.value].filter(Boolean) })}>
              <option value="">none</option>{templates.filter((t) => t.id !== s.templateIds?.[0]).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></div>
          {i > 0 && <div className="field fit"><button className="sm danger" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Remove</button></div>}
        </div>
      ))}
      <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
        <button className="fit" disabled={steps.length >= 8} onClick={() => setSteps([...steps, { delayDays: 7 }])}>+ Add follow-up</button>
        <div className="row fit" style={{ flexWrap: "nowrap" }}>
          {seq && !seq.is_default && <button className="fit" disabled={a.busy} onClick={() => a.run(() => api(`/api/sequences/${seq.id}`, "PATCH", { isDefault: true }))}>Make default</button>}
          {seq && <button className="fit danger" disabled={a.busy} onClick={() => a.run(() => api(`/api/sequences/${seq.id}`, "DELETE"))}>Delete</button>}
          <button className="fit primary" disabled={a.busy} onClick={save}>{seq ? "Save" : "Create sequence"}</button>
        </div>
      </div>
    </div>
  );
}
