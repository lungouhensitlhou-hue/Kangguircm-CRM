"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { STAGES, STAGE_LABELS, type Stage } from "@rcm/core/types";
import { api } from "./useApi";

export interface Card { id: string; name: string; specialty: string | null; city: string | null; state: string | null; score: number; stage: Stage }

export function Kanban({ cards: initial }: { cards: Card[] }) {
  const router = useRouter();
  const [cards, setCards] = useState(initial);
  const [over, setOver] = useState<Stage | null>(null);
  const [error, setError] = useState("");
  async function move(id: string, stage: Stage) {
    const prev = cards;
    setCards(cards.map((c) => (c.id === id ? { ...c, stage } : c)));
    try { await api(`/api/leads/${id}`, "PATCH", { stage }); router.refresh(); }
    catch (e) { setCards(prev); setError((e as Error).message); }
  }
  return (
    <>
      {error && <div className="notice err" role="alert">{error}</div>}
      <div className="kanban" data-testid="kanban">
        {STAGES.map((s) => {
          const col = cards.filter((c) => c.stage === s);
          return (
            <div key={s} className={`col ${over === s ? "over" : ""}`} data-stage={s}
              onDragOver={(e) => { e.preventDefault(); setOver(s); }} onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/plain"); if (id) move(id, s); }}>
              <h3>{STAGE_LABELS[s]} <span className="badge">{col.length}</span></h3>
              {col.map((c) => (
                <div key={c.id} className="kcard" draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", c.id)}>
                  <Link href={`/leads/${c.id}`}><strong>{c.name}</strong></Link>
                  <div className="small muted">{c.specialty ?? "–"} · {[c.city, c.state].filter(Boolean).join(", ")}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, alignItems: "center" }}>
                    <span className="badge">{c.score}</span>
                    <select aria-label={`Move ${c.name}`} value={c.stage} style={{ width: "auto", padding: "2px 4px", fontSize: 12 }} onChange={(e) => move(c.id, e.target.value as Stage)}>
                      {STAGES.map((x) => <option key={x} value={x}>{STAGE_LABELS[x]}</option>)}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
