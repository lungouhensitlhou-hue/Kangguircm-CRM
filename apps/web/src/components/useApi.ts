"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export async function api<T = any>(url: string, method = "GET", data?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: data !== undefined ? { "content-type": "application/json" } : undefined, body: data !== undefined ? JSON.stringify(data) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `Request failed (${res.status})`);
  return j as T;
}

/** Wraps an async action with busy/error state and refreshes server data afterwards. */
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
    setBusy(true); setError(null); setOk(null);
    try { const r = await fn(); if (success) setOk(success); router.refresh(); return r; }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return { busy, error, ok, run, setError, setOk };
}
