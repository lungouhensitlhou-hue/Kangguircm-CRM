"use client";
import Link from "next/link";
import { useState } from "react";
import { api, useAction } from "./useApi";

export interface TaskItem { id: string; title: string; kind: string; due_at: string; status: string; lead_id: string | null; org_name: string | null; source: string }

export function TaskList({ tasks, empty = "Nothing here." }: { tasks: TaskItem[]; empty?: string }) {
  const a = useAction();
  const upd = (id: string, patch: object) => a.run(() => api(`/api/tasks/${id}`, "PATCH", patch));
  const due = (d: string) => { const t = new Date(d); const days = Math.floor((t.getTime() - Date.now()) / 86400_000); return days < 0 ? `${-days}d overdue` : t.toDateString() === new Date().toDateString() ? "today" : `in ${days + 1}d`; };
  return (
    <div>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      {tasks.length === 0 && <div className="muted">{empty}</div>}
      <ul className="plain" data-testid="tasks">
        {tasks.map((t) => (
          <li key={t.id} style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <strong>{t.title}</strong>
              <div className="small muted"><span className="badge">{t.kind}</span> {t.status === "open" ? due(t.due_at) : t.status}{t.org_name && t.lead_id ? <> · <Link href={`/leads/${t.lead_id}`}>{t.org_name}</Link></> : null}</div>
            </div>
            {t.status === "open" ? (
              <div className="row fit" style={{ flexWrap: "nowrap" }}>
                <button className="sm fit primary" disabled={a.busy} onClick={() => upd(t.id, { status: "done" })}>Done</button>
                <button className="sm fit" disabled={a.busy} onClick={() => upd(t.id, { snoozeDays: 1 })}>+1d</button>
                <button className="sm fit" disabled={a.busy} onClick={() => upd(t.id, { snoozeDays: 7 })}>+7d</button>
                <button className="sm fit danger" disabled={a.busy} onClick={() => upd(t.id, { status: "dismissed" })}>Dismiss</button>
              </div>
            ) : <button className="sm fit" disabled={a.busy} onClick={() => upd(t.id, { status: "open" })}>Reopen</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AddTask({ leadId }: { leadId?: string }) {
  const a = useAction();
  const [title, setTitle] = useState("");
  const [days, setDays] = useState(0);
  const [kind, setKind] = useState("other");
  return (
    <form onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api("/api/tasks", "POST", { title, leadId, kind, dueInDays: Number(days) }); setTitle(""); }); }}>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      <div className="row">
        <div className="field" style={{ flex: "3 1 200px" }}><label htmlFor={`tt-${leadId ?? "x"}`}>New task</label><input id={`tt-${leadId ?? "x"}`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Call the practice manager" required /></div>
        <div className="field"><label htmlFor={`tk-${leadId ?? "x"}`}>Type</label><select id={`tk-${leadId ?? "x"}`} value={kind} onChange={(e) => setKind(e.target.value)}>{["call", "email", "review", "research", "other"].map((k) => <option key={k}>{k}</option>)}</select></div>
        <div className="field" style={{ maxWidth: 110 }}><label htmlFor={`td-${leadId ?? "x"}`}>Due in (days)</label><input id={`td-${leadId ?? "x"}`} type="number" min={0} value={days} onChange={(e) => setDays(Number(e.target.value))} /></div>
        <div className="field fit"><button disabled={a.busy || !title.trim()}>Add task</button></div>
      </div>
    </form>
  );
}
