import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, verifySession } from "@/lib/auth";

/** Gatekeeper: everything except login, the public unsubscribe flow and webhooks requires a session. Routes re-check auth themselves. */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const open = pathname === "/login" || pathname.startsWith("/unsubscribe/") || pathname.startsWith("/api/unsubscribe/") || pathname === "/api/inbound" || pathname === "/api/health" || pathname === "/api/auth/login";
  if (open) return NextResponse.next();
  const ok = await verifySession(req.cookies.get(COOKIE)?.value);
  if (ok) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
