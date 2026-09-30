import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const COOKIE = "rcm_session";
const MAX_AGE = 60 * 60 * 12;

export function authConfig() {
  const dev = process.env.NODE_ENV !== "production";
  const email = process.env.ADMIN_EMAIL ?? (dev ? "admin@kangguircm.local" : "");
  const password = process.env.ADMIN_PASSWORD ?? (dev ? "changeme" : "");
  const secret = process.env.SESSION_SECRET ?? (dev ? "dev-only-secret-change-me-dev-only-secret" : "");
  return { email, password, secret, usingDefaults: dev && !process.env.ADMIN_PASSWORD };
}

const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");

async function hmacKey(secret: string, usage: KeyUsage[]) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export async function signSession(email: string, now = Date.now()): Promise<string> {
  const { secret } = authConfig();
  if (secret.length < 24) throw new Error("SESSION_SECRET must be set (24+ chars)");
  const payload = b64u(enc.encode(JSON.stringify({ email, exp: now + MAX_AGE * 1000 })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(payload));
  return `${payload}.${b64u(sig)}`;
}

export async function verifySession(token: string | undefined | null, now = Date.now()): Promise<{ email: string } | null> {
  if (!token) return null;
  const { secret } = authConfig();
  if (secret.length < 24) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), Buffer.from(sig, "base64url"), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof data.exp !== "number" || data.exp < now) return null;
    return { email: String(data.email) };
  } catch {
    return null;
  }
}

/** Constant-time credential check (hash first so lengths never leak). */
export async function checkCredentials(email: string, password: string): Promise<boolean> {
  const cfg = authConfig();
  if (!cfg.password || !cfg.email) return false;
  const h = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  const [a, b, c, d] = await Promise.all([h(email.trim().toLowerCase()), h(cfg.email.toLowerCase()), h(password), h(cfg.password)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ^ b[i]) | (c[i] ^ d[i]);
  return diff === 0;
}

export function sessionCookieOptions() {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1", path: "/", maxAge: MAX_AGE };
}

export async function currentUser() {
  const jar = await cookies();
  return verifySession(jar.get(COOKIE)?.value);
}

/** For server components: redirect to /login when unauthenticated. */
export async function requireUser() {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}
