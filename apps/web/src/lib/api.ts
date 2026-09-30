import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { currentUser } from "./auth";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });

/** Block cross-site form posts: if an Origin header is present it must match the Host. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === (req.headers.get("x-forwarded-host") ?? req.headers.get("host")); } catch { return false; }
}

type Ctx<P> = { params: Promise<P> };

/** Wrap a route handler: auth (default), same-origin check on mutations, uniform JSON errors. */
export function route<P = Record<string, string>>(
  fn: (req: Request, ctx: { params: P; user: { email: string } | null }) => Promise<Response | unknown>,
  opts: { public?: boolean } = {},
) {
  return async (req: Request, ctx: Ctx<P>) => {
    try {
      const user = await currentUser();
      if (!opts.public) {
        if (!user) throw new HttpError(401, "Not signed in");
        if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) throw new HttpError(403, "Cross-origin request blocked");
      }
      const out = await fn(req, { params: await (ctx?.params ?? Promise.resolve({} as P)), user });
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e instanceof ZodError) return json({ error: e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") }, 400);
      const msg = (e as Error).message ?? "Server error";
      // Domain errors thrown deliberately by core (validation-style) are safe to show; everything else is logged.
      const domain = /not found|only drafts|cannot|invalid|required|complete settings|suppress|already/i.test(msg);
      if (!domain) console.error("[api]", req.method, new URL(req.url).pathname, e);
      return json({ error: domain ? msg : "Server error" }, domain ? 400 : 500);
    }
  };
}

export async function body<T = any>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw new HttpError(400, "Invalid JSON body"); }
}
