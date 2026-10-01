"use client";
import Link from "next/link";
import { useState } from "react";
import { api, useAction } from "./useApi";

export function SavedViews({ views, current, exportHref }: { views: { id: string; name: string; filters: Record<string, string> }[]; current: Record<string, string>; exportHref: string }) {
  const a = useAction();
  const [name, setName] = useState("");
  const href = (f: Record<string, string>) => `/leads?${new URLSearchParams(f).toString()}`;
  const hasFilters = Object.values(current).some(Boolean);
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      <div className="row" style={{ alignItems: "center" }}>
        <span className="muted fit">Saved views:</span>
        {views.length === 0 && <span className="muted small fit">none yet</span>}
        {views.map((v) => (
          <span key={v.id} className="fit" style={{ whiteSpace: "nowrap" }}>
            <Link className="badge brand" href={href(v.filters)}>{v.name}</Link>
            <button className="sm" aria-label={`Delete view ${v.name}`} style={{ border: 0, padding: "0 4px", background: "transparent" }} disabled={a.busy} onClick={() => a.run(() => api(`/api/views/${v.id}`, "DELETE"))}>×</button>
          </span>
        ))}
        <span style={{ flex: "1 1 20px" }} />
        {hasFilters && (
          <>
            <input aria-label="View name" style={{ maxWidth: 170 }} className="fit" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this filter" />
            <button className="fit sm" disabled={a.busy || !name.trim()} onClick={() => a.run(async () => { await api("/api/views", "POST", { name, filters: current }); setName(""); })}>Save view</button>
          </>
        )}
        <a className="btn sm fit" href={exportHref} download>Export CSV</a>
      </div>
    </div>
  );
}
