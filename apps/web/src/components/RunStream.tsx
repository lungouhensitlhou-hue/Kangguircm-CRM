"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Ev { id: number; type: string; message: string; data: unknown; created_at: string }
const cls = (t: string) => (t === "error" ? "e" : t === "warn" ? "w" : t === "tool" ? "t" : t === "progress" ? "d" : "");

export function RunStream({ runId, initialStatus }: { runId: string; initialStatus: string }) {
  const router = useRouter();
  const [events, setEvents] = useState<Ev[]>([]);
  const [status, setStatus] = useState(initialStatus);
  const [live, setLive] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let closed = false;
    const seen = new Set<number>();
    const add = (e: Ev) => { if (seen.has(e.id)) return; seen.add(e.id); setEvents((cur) => [...cur, e]); };
    const es = new EventSource(`/api/runs/${runId}/events`);
    es.onopen = () => setLive(true);
    es.addEventListener("event", (m) => add(JSON.parse((m as MessageEvent).data)));
    es.addEventListener("done", (m) => { setStatus(JSON.parse((m as MessageEvent).data).status); setLive(false); es.close(); router.refresh(); });
    es.onerror = () => { setLive(false); };
    return () => { closed = true; es.close(); void closed; };
  }, [runId, router]);

  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [events.length]);

  return (
    <div>
      <div className="small muted" style={{ marginBottom: 6 }}>
        Status: <strong data-testid="run-status">{status}</strong> {live && <span className="badge info">live</span>}
      </div>
      <div className="log" ref={box} data-testid="run-log">
        {events.length === 0 && <div className="muted">Waiting for the worker to pick this up…</div>}
        {events.map((e) => (
          <div key={e.id} className={cls(e.type)}>
            <span style={{ opacity: 0.5 }}>{new Date(e.created_at).toLocaleTimeString()} </span>
            {e.type === "tool" ? `⚙ ${e.message} ` : ""}{e.type !== "tool" ? e.message : ""}
            {e.type === "tool" && e.data ? <span style={{ opacity: 0.7 }}>{JSON.stringify(e.data).slice(0, 220)}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
