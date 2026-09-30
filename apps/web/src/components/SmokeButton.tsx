"use client";
import { useRouter } from "next/navigation";
import { api, useAction } from "./useApi";
export function SmokeButton() {
  const router = useRouter();
  const a = useAction();
  return <button disabled={a.busy} onClick={async () => { const r = await a.run(() => api<{ runId: string }>("/api/runs", "POST", { steps: 4, delayMs: 400 })); if (r) router.push(`/runs/${r.runId}`); }}>Run system self-test</button>;
}
