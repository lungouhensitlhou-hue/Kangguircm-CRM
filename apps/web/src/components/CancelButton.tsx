"use client";
import { api, useAction } from "./useApi";
export function CancelButton({ runId }: { runId: string }) {
  const a = useAction();
  return <span>{a.error && <span className="badge bad">{a.error}</span>} <button className="danger sm" disabled={a.busy} onClick={() => a.run(() => api(`/api/runs/${runId}/cancel`, "POST", {}))}>Cancel run</button></span>;
}
