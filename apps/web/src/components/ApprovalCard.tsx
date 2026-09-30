"use client";
import Link from "next/link";
import { useState } from "react";
import { api, useAction } from "./useApi";

export interface Draft { id: string; lead_id: string; org_name: string; to_email: string; contact_name: string | null; step: number; subject: string; body: string }

export function ApprovalCard({ d }: { d: Draft }) {
  const a = useAction();
  const [subject, setSubject] = useState(d.subject);
  // Only the editable part; the compliance footer is regenerated server-side and cannot be removed.
  const split = d.body.split(/\n--\n/);
  const [text, setText] = useState(split[0]);
  const footer = split.slice(1).join("\n--\n");
  const dirty = subject !== d.subject || text !== split[0];
  return (
    <div className="card" data-testid="draft">
      <div className="head" style={{ marginBottom: 8 }}>
        <div><Link href={`/leads/${d.lead_id}`}><strong>{d.org_name}</strong></Link> <span className="badge">Step {d.step}</span><div className="small muted">To: {d.contact_name ? `${d.contact_name} ` : ""}&lt;{d.to_email}&gt;</div></div>
      </div>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      <div className="field"><label htmlFor={`s-${d.id}`}>Subject</label><input id={`s-${d.id}`} value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
      <div className="field"><label htmlFor={`b-${d.id}`}>Message</label><textarea id={`b-${d.id}`} value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 190 }} /></div>
      <div className="small muted email" style={{ marginBottom: 12 }}>-- (added automatically, required by CAN-SPAM)&#10;{footer}</div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="fit danger" disabled={a.busy} onClick={() => a.run(() => api(`/api/messages/${d.id}`, "PATCH", { action: "reject" }))}>Reject</button>
        {dirty && <button className="fit" disabled={a.busy} onClick={() => a.run(() => api(`/api/messages/${d.id}`, "PATCH", { action: "edit", subject, body: text }))}>Save edits</button>}
        <button className="fit primary" disabled={a.busy} onClick={() => a.run(() => api(`/api/messages/${d.id}`, "PATCH", { action: "approve", subject, body: text }))}>Approve &amp; queue send</button>
      </div>
    </div>
  );
}
