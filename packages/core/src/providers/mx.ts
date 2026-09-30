import dns from "node:dns/promises";

export type MxCheck = (domain: string) => Promise<boolean>;

/** True if the domain can receive mail: has MX records, or (RFC 5321 fallback) an address record. */
export function dnsMxCheck(resolver: Pick<typeof dns, "resolveMx" | "resolve4" | "resolve6"> = dns): MxCheck {
  const cache = new Map<string, boolean>();
  return async (domain) => {
    const d = domain.trim().toLowerCase();
    const hit = cache.get(d);
    if (hit !== undefined) return hit;
    let ok = false;
    try {
      const mx = await resolver.resolveMx(d);
      ok = mx.some((r) => r.exchange && r.exchange !== ".");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENODATA" || code === "ENOTFOUND") {
        try { ok = (await resolver.resolve4(d)).length > 0; } catch { try { ok = (await resolver.resolve6(d)).length > 0; } catch { ok = false; } }
      } else if (code === "ETIMEOUT" || code === "ESERVFAIL" || code === "ECONNREFUSED" || code === "EAI_AGAIN") {
        return true; // resolver trouble is not evidence the address is bad: fail open, don't cache
      }
    }
    cache.set(d, ok);
    return ok;
  };
}

export const alwaysDeliverable: MxCheck = async () => true;
