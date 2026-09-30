"use client";
import { useState } from "react";
export function UnsubscribeForm({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "err">("idle");
  if (state === "done") return <div className="notice ok" role="status">You have been unsubscribed and will not receive further emails from us.</div>;
  return (
    <>
      {state === "err" && <div className="notice err">This link is invalid or has expired.</div>}
      <button className="primary" disabled={state === "busy"} onClick={async () => { setState("busy"); const r = await fetch(`/api/unsubscribe/${encodeURIComponent(token)}`, { method: "POST" }); setState(r.ok ? "done" : "err"); }}>Confirm unsubscribe</button>
    </>
  );
}
