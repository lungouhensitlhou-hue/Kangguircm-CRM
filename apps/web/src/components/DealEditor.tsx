"use client";
import { useState } from "react";
import { api, useAction } from "./useApi";

export interface DealItem { id: string; lead_id: string; name: string; value_usd: number; status: "open" | "won" | "lost"; expected_close: string | null; notes: string }

export function DealEditor({ deal }: { deal: DealItem }) {
  const a = useAction();
  const [value, setValue] = useState(String(Number(deal.value_usd)));
  const [close, setClose] = useState(deal.expected_close ? deal.expected_close.slice(0, 10) : "");
  const save = () => a.run(() => api(`/api/deals/${deal.id}`, "PATCH", { valueUsd: Number(value), expectedClose: close || null }), "Saved.");
  return (
    <div>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field"><label htmlFor={`dv-${deal.id}`}>Value (USD)</label><input id={`dv-${deal.id}`} type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} disabled={deal.status !== "open"} /></div>
        <div className="field"><label htmlFor={`dc-${deal.id}`}>Expected close</label><input id={`dc-${deal.id}`} type="date" value={close} onChange={(e) => setClose(e.target.value)} disabled={deal.status !== "open"} /></div>
        {deal.status === "open" ? (
          <>
            <div className="field fit"><button disabled={a.busy} onClick={save}>Save</button></div>
            <div className="field fit"><button className="primary" disabled={a.busy} onClick={() => a.run(() => api(`/api/deals/${deal.id}`, "PATCH", { status: "won", valueUsd: Number(value) }))}>Mark won</button></div>
            <div className="field fit"><button className="danger" disabled={a.busy} onClick={() => a.run(() => api(`/api/deals/${deal.id}`, "PATCH", { status: "lost" }))}>Mark lost</button></div>
          </>
        ) : <div className="field fit"><button disabled={a.busy} onClick={() => a.run(() => api(`/api/deals/${deal.id}`, "PATCH", { status: "open" }))}>Reopen</button></div>}
      </div>
      {a.ok && <div className="small muted">{a.ok}</div>}
    </div>
  );
}

export function CreateDeal({ leadId }: { leadId: string }) {
  const a = useAction();
  const [value, setValue] = useState("");
  return (
    <div>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field"><label htmlFor="nd-value">Estimated annual value (USD)</label><input id="nd-value" type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} /></div>
        <div className="field fit"><button disabled={a.busy} onClick={() => a.run(() => api("/api/deals", "POST", { leadId, valueUsd: value ? Number(value) : undefined }))}>Create deal</button></div>
      </div>
    </div>
  );
}
