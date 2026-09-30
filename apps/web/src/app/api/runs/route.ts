import { enqueueRun, listRuns } from "@rcm/core";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const p = new URL(req.url).searchParams;
  return { runs: await listRuns({ limit: Number(p.get("limit") ?? 50), status: p.get("status") ?? undefined, kind: p.get("kind") ?? undefined }) };
});

/** Only the diagnostic "smoke" run can be launched directly; real agents are launched via their own endpoints. */
export const POST = route(async (req, { user }) => {
  const b = await body<{ steps?: number; delayMs?: number }>(req);
  const run = await enqueueRun({ kind: "smoke", input: { steps: Math.min(Number(b.steps ?? 3), 20), delayMs: Math.min(Number(b.delayMs ?? 400), 3000) }, createdBy: user!.email, maxAttempts: 1 });
  return { runId: run.id };
});
