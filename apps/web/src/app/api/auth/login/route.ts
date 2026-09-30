import { NextResponse } from "next/server";
import { COOKIE, checkCredentials, sessionCookieOptions, signSession } from "@/lib/auth";
import { audit } from "@rcm/core";

export const dynamic = "force-dynamic";

// Tiny in-memory throttle: 8 failures per 15 min per IP. (Put a WAF/edge limiter in front for multi-instance deploys.)
const fails = new Map<string, { n: number; reset: number }>();

export async function POST(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const rec = fails.get(ip);
  if (rec && rec.reset > Date.now() && rec.n >= 8) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  let email = "", password = "";
  try { ({ email = "", password = "" } = await req.json()); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }
  if (!(await checkCredentials(String(email), String(password)))) {
    fails.set(ip, { n: (rec && rec.reset > Date.now() ? rec.n : 0) + 1, reset: rec && rec.reset > Date.now() ? rec.reset : Date.now() + 15 * 60_000 });
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }
  fails.delete(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, await signSession(String(email).trim().toLowerCase()), sessionCookieOptions());
  await audit(String(email), "login").catch(() => {});
  return res;
}
