"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "./useApi";

interface M { id: string; role: "user" | "assistant"; content: string; created_at: string }

export function Chat({ initial, hasLlm }: { initial: M[]; hasLlm: boolean }) {
  const [msgs, setMsgs] = useState<M[]>(initial);
  const [text, setText] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs.length, waiting]);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(async () => {
      try {
        const r = await api<{ messages: M[]; pending: boolean }>("/api/chat");
        setMsgs(r.messages);
        if (!r.pending) setWaiting(false);
      } catch { /* keep polling */ }
    }, 1000);
    return () => clearInterval(t);
  }, [waiting]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message || waiting) return;
    setText(""); setError("");
    setMsgs((m) => [...m, { id: `tmp-${Date.now()}`, role: "user", content: message, created_at: new Date().toISOString() }]);
    try { await api("/api/chat", "POST", { message }); setWaiting(true); }
    catch (err) { setError((err as Error).message); }
  }

  return (
    <div className="card chatbox">
      {!hasLlm && <div className="notice warn small">AI is not configured, so I only understand simple commands (type <code>help</code>). Set <code>ANTHROPIC_API_KEY</code> on the worker for full natural language.</div>}
      <div className="msgs" data-testid="chat-msgs">
        {msgs.length === 0 && <div className="muted">Try: “Find 30 orthopedic groups in Texas and research the best ones”, “How is my pipeline?”, “Draft an email for Riverside Orthopedics”.</div>}
        {msgs.map((m) => <div key={m.id} className={`bubble ${m.role}`}>{m.content}</div>)}
        {waiting && <div className="bubble assistant muted">Working…</div>}
        <div ref={end} />
      </div>
      {error && <div className="notice err" role="alert">{error}</div>}
      <form className="row" onSubmit={send} style={{ marginTop: 10 }}>
        <input aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask your agents to do something…" autoComplete="off" />
        <button className="primary fit" disabled={waiting || !text.trim()}>Send</button>
      </form>
    </div>
  );
}
