"use client";
import { useState } from "react";
import { api, useAction } from "./useApi";

export interface TemplateItem { id: string; name: string; subject: string; body: string; active: boolean }

const SAMPLE: Record<string, string> = { first_name: "Jane", full_name: "Jane Smith", title: "Practice Manager", practice: "Riverside Orthopedics", city: "Austin", state: "TX", specialty: "Orthopedic Surgery", ehr: "athenahealth", sender_name: "Sam Rivers", sender_first_name: "Sam", company: "Kangguircm" };
const render = (t: string) => t.replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (_m, f: string, fb?: string) => SAMPLE[f.toLowerCase()] ?? fb ?? `⟨unknown ${f}⟩`);

export function TemplateEditor({ template, fields }: { template?: TemplateItem; fields: Record<string, string> }) {
  const a = useAction();
  const [name, setName] = useState(template?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const id = template?.id ?? "new";
  const save = () => a.run(async () => {
    if (template) await api(`/api/templates/${template.id}`, "PATCH", { name, subject, body });
    else { await api("/api/templates", "POST", { name, subject, body }); setName(""); setSubject(""); setBody(""); }
  }, template ? "Saved." : "Template created.");
  return (
    <div className="card" data-testid={template ? "template" : "new-template"}>
      <h2>{template ? template.name : "New template"} {template && !template.active && <span className="badge">inactive</span>}</h2>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      {a.ok && <div className="notice ok" role="status">{a.ok}</div>}
      <div className="field"><label htmlFor={`tn-${id}`}>Name</label><input id={`tn-${id}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Intro A: denial angle" /></div>
      <div className="field"><label htmlFor={`ts-${id}`}>Subject</label><input id={`ts-${id}`} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Fewer denials at {{practice}}" /></div>
      <div className="field"><label htmlFor={`tb-${id}`}>Body</label><textarea id={`tb-${id}`} style={{ minHeight: 160 }} value={body} onChange={(e) => setBody(e.target.value)} placeholder={"Hi {{first_name|there}},\n\n…"} /></div>
      <details style={{ marginBottom: 10 }}><summary className="small muted">Merge fields (use {"{{field}}"} or {"{{field|fallback}}"})</summary><ul className="plain small">{Object.entries(fields).map(([k, v]) => <li key={k}><code>{`{{${k}}}`}</code> {v}</li>)}</ul></details>
      {(subject || body) && <div className="email small" style={{ marginBottom: 10 }} data-testid="preview"><strong>{render(subject)}</strong>{"\n\n"}{render(body)}</div>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        {template && <button className="fit" disabled={a.busy} onClick={() => a.run(() => api(`/api/templates/${template.id}`, "PATCH", { active: !template.active }))}>{template.active ? "Deactivate" : "Activate"}</button>}
        {template && <button className="fit danger" disabled={a.busy} onClick={() => a.run(() => api(`/api/templates/${template.id}`, "DELETE"))}>Delete</button>}
        <button className="fit primary" disabled={a.busy} onClick={save}>{template ? "Save" : "Create template"}</button>
      </div>
    </div>
  );
}
