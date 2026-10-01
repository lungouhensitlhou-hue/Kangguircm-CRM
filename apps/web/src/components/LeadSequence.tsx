"use client";
import { useState } from "react";
import { api, useAction } from "./useApi";

export function LeadSequence({ leadId, sequenceId, paused, sequences, tags }: { leadId: string; sequenceId: string | null; paused: boolean; sequences: { id: string; name: string; is_default: boolean }[]; tags: string[] }) {
  const a = useAction();
  const [tagText, setTagText] = useState(tags.join(", "));
  const [isPaused, setPaused] = useState(paused);
  const def = sequences.find((s) => s.is_default);
  return (
    <div className="card">
      <h2>Sequence &amp; tags</h2>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      {a.ok && <div className="notice ok" role="status">{a.ok}</div>}
      <div className="field">
        <label htmlFor="seq">Follow-up sequence</label>
        <select id="seq" value={sequenceId ?? ""} disabled={a.busy} onChange={(e) => a.run(() => api(`/api/leads/${leadId}`, "PATCH", { sequenceId: e.target.value || null }), "Sequence updated.")}>
          <option value="">{def ? `Default (${def.name})` : "Default (Settings follow-up days)"}</option>
          {sequences.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400, color: "var(--text)", marginBottom: 12 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={isPaused} onChange={async (e) => { const v = e.target.checked; setPaused(v); const r = await a.run(() => api(`/api/leads/${leadId}`, "PATCH", { sequencePaused: v }), v ? "Follow-ups paused." : "Follow-ups resumed."); if (r === undefined) setPaused(!v); }} /> Pause follow-ups for this lead
      </label>
      <div className="field">
        <label htmlFor="tags">Tags (comma-separated)</label>
        <input id="tags" value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="pilot, texas, priority" />
      </div>
      <button disabled={a.busy} onClick={() => a.run(() => api(`/api/leads/${leadId}`, "PATCH", { tags: tagText.split(",").map((t) => t.trim()).filter(Boolean) }), "Tags saved.")}>Save tags</button>
    </div>
  );
}
