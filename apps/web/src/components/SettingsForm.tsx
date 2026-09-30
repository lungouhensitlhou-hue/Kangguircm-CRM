"use client";
import { useState } from "react";
import { api, useAction } from "./useApi";

export interface S {
  senderName: string; senderEmail: string; companyName: string; physicalAddress: string; dailySendCap: number;
  sendWindowStartHour: number; sendWindowEndHour: number; timezone: string; sendOnWeekends: boolean; trackOpens: boolean; followupDays: number[]; autoApprove: boolean; offer: string;
}

export function SettingsForm({ initial }: { initial: S }) {
  const a = useAction();
  const [s, setS] = useState(initial);
  const [days, setDays] = useState(initial.followupDays.join(", "));
  const set = <K extends keyof S>(k: K, v: S[K]) => setS({ ...s, [k]: v });
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(() => api("/api/settings", "PUT", { ...s, followupDays: days.split(/[ ,]+/).filter(Boolean).map(Number) }), "Settings saved."); }}>
      <h2>Sender identity &amp; compliance</h2>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      {a.ok && <div className="notice ok" role="status">{a.ok}</div>}
      <div className="row">
        <div className="field"><label htmlFor="sn">Your name</label><input id="sn" value={s.senderName} onChange={(e) => set("senderName", e.target.value)} required /></div>
        <div className="field"><label htmlFor="se">Sender email</label><input id="se" type="email" value={s.senderEmail} onChange={(e) => set("senderEmail", e.target.value)} placeholder="you@yourdomain.com" /></div>
        <div className="field"><label htmlFor="cn">Company name</label><input id="cn" value={s.companyName} onChange={(e) => set("companyName", e.target.value)} required /></div>
      </div>
      <div className="field"><label htmlFor="pa">Physical mailing address (required in every email by CAN-SPAM)</label><input id="pa" value={s.physicalAddress} onChange={(e) => set("physicalAddress", e.target.value)} placeholder="123 Main St, Suite 100, Austin, TX 78701" /></div>
      <div className="field"><label htmlFor="of">What you offer (used by the drafting agent)</label><textarea id="of" style={{ minHeight: 70 }} value={s.offer} onChange={(e) => set("offer", e.target.value)} /></div>
      <h2 style={{ marginTop: 16 }}>Sending guardrails</h2>
      <div className="row">
        <div className="field"><label htmlFor="cap">Daily send cap</label><input id="cap" type="number" min={0} max={2000} value={s.dailySendCap} onChange={(e) => set("dailySendCap", Number(e.target.value))} /></div>
        <div className="field"><label htmlFor="ws">Window start (hour)</label><input id="ws" type="number" min={0} max={23} value={s.sendWindowStartHour} onChange={(e) => set("sendWindowStartHour", Number(e.target.value))} /></div>
        <div className="field"><label htmlFor="we">Window end (hour)</label><input id="we" type="number" min={1} max={24} value={s.sendWindowEndHour} onChange={(e) => set("sendWindowEndHour", Number(e.target.value))} /></div>
        <div className="field"><label htmlFor="tz">Timezone</label><input id="tz" value={s.timezone} onChange={(e) => set("timezone", e.target.value)} /></div>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400, color: "var(--text)", marginBottom: 12 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={s.sendOnWeekends} onChange={(e) => set("sendOnWeekends", e.target.checked)} /> Also send on weekends
      </label>
      <div className="field"><label htmlFor="fu">Follow-up gaps in days (e.g. “3, 7” = two follow-ups)</label><input id="fu" value={days} onChange={(e) => setDays(e.target.value)} /></div>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400, color: "var(--text)", marginBottom: 14 }}>
        <input type="checkbox" style={{ width: "auto", marginTop: 3 }} checked={s.autoApprove} onChange={(e) => set("autoApprove", e.target.checked)} />
        <span><strong>Auto-approve drafts</strong> (skip human review; sends still obey window, cap and suppression). Leave off until you trust the drafts.</span>
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 400, color: "var(--text)", marginBottom: 14 }}>
        <input type="checkbox" style={{ width: "auto", marginTop: 3 }} checked={s.trackOpens} onChange={(e) => set("trackOpens", e.target.checked)} />
        <span><strong>Track email opens (approximate)</strong>. Adds a hidden 1-pixel image and an HTML version of each email. Many apps preload images (Apple Mail, Gmail) and security scanners open everything, so counts are a hint, not proof. It can also lower inbox placement for cold email. Leave off unless you want the hint.</span>
      </label>
      <button className="primary" disabled={a.busy}>Save settings</button>
    </form>
  );
}

export function Suppressions({ items }: { items: { email: string; reason: string }[] }) {
  const a = useAction();
  const [email, setEmail] = useState("");
  return (
    <div className="card">
      <h2>Do-not-contact list</h2>
      <div className="small muted" style={{ marginBottom: 8 }}>Unsubscribes and opt-out replies land here automatically. Use <code>@domain.com</code> to block a whole domain.</div>
      {a.error && <div className="notice err" role="alert">{a.error}</div>}
      <form className="row" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api("/api/suppressions", "POST", { email }); setEmail(""); }); }}>
        <input aria-label="Email to suppress" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@practice.com or @practice.com" />
        <button className="fit" disabled={a.busy || !email}>Add</button>
      </form>
      <ul className="plain" style={{ marginTop: 10 }}>
        {items.length === 0 && <li className="muted">Empty</li>}
        {items.map((i) => (
          <li key={i.email} style={{ display: "flex", justifyContent: "space-between" }}><span>{i.email} <span className="badge">{i.reason}</span></span>
            <button className="sm" onClick={() => a.run(() => api("/api/suppressions", "DELETE", { email: i.email }))}>Remove</button></li>
        ))}
      </ul>
    </div>
  );
}
