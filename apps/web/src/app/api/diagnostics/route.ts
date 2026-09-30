import { depsFromEnv, runDiagnostics } from "@rcm/core";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST { deep: true } runs the live connection test (AI, registry, search, email provider auth, DNS). Never sends an email. */
export const POST = route(async (req) => {
  const { deep } = await body<{ deep?: boolean }>(req).catch(() => ({ deep: false }));
  const results = await runDiagnostics(depsFromEnv(process.env, () => {}), { deep: !!deep });
  return { results, ok: !results.some((r) => r.status === "fail"), checkedAt: new Date().toISOString() };
});
