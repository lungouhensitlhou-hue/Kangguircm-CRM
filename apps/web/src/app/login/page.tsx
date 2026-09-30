"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    if (res.ok) { router.push("/"); router.refresh(); return; }
    setError((await res.json().catch(() => ({}))).error ?? "Sign-in failed"); setBusy(false);
  }
  return (
    <div className="center">
      <form className="card narrow" onSubmit={submit}>
        <h1 style={{ color: "var(--brand)" }}>Kangguircm RCM</h1>
        <p className="muted" style={{ marginTop: 0 }}>Command center sign-in</p>
        {error && <div className="notice err" role="alert">{error}</div>}
        <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <button className="primary" style={{ width: "100%" }} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}
