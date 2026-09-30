"use client";
import { useState } from "react";
import { api } from "./useApi";

interface Check { name: string; status: "pass" | "fail" | "warn" | "skip"; detail: string; hint?: string }
const BADGE = { pass: "ok", fail: "bad", warn: "warn", skip: "" } as const;

export function Diagnostics() {
  const [results, setResults] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(deep: boolean) {
    setBusy(true); setError("");
    try { setResults((await api<{ results: Check[] }>("/api/diagnostics", "POST", { deep })).results); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <div className="card">
      <h2>Connection test</h2>
      <div className="small muted" style={{ marginBottom: 10 }}>Checks configuration, database, worker, and (full test) every connected service: AI, registry, search, email provider login and sender domain. It never sends an email. Run the full test after changing any key.</div>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="fit" disabled={busy} onClick={() => run(false)}>Quick check</button>
        <button className="fit primary" disabled={busy} onClick={() => run(true)}>{busy ? "Testing…" : "Full test"}</button>
      </div>
      {error && <div className="notice err" role="alert">{error}</div>}
      {results && (
        <ul className="plain" data-testid="diagnostics">
          {results.map((r, i) => (
            <li key={i}>
              <span className={`badge ${BADGE[r.status]}`}>{r.status.toUpperCase()}</span> <strong>{r.name}</strong>
              <div className="small muted">{r.detail}</div>
              {r.hint && <div className="small">→ {r.hint}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
