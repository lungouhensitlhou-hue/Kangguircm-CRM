import { DiscoverInput, enqueueRun } from "@rcm/core";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";

export const POST = route(async (req, { user }) => {
  const input = DiscoverInput.parse(await body(req));
  const run = await enqueueRun({ kind: "discover", input, createdBy: user!.email, maxAttempts: 2 });
  return { runId: run.id };
});
