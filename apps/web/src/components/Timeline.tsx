import type { TimelineItem } from "@rcm/core";
import { ago } from "@/lib/format";

const KIND: Record<string, string> = { email: "info", reply: "ok", stage: "brand", task: "warn", deal: "ok", run: "", delivery: "info" };

export function Timeline({ items }: { items: TimelineItem[] }) {
  if (!items.length) return <div className="muted">Nothing yet.</div>;
  return (
    <ul className="plain" data-testid="timeline">
      {items.map((t, i) => (
        <li key={i} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
          <span className={`badge ${KIND[t.kind] ?? ""}`} style={{ minWidth: 62, textAlign: "center" }}>{t.kind}</span>
          <div style={{ flex: 1 }}><strong>{t.title}</strong>{t.detail && <div className="small muted">{t.detail}</div>}</div>
          <span className="small muted" title={new Date(t.at).toLocaleString()}>{ago(t.at)}</span>
        </li>
      ))}
    </ul>
  );
}
