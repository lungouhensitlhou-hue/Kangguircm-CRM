import { audit, cancelRun } from "@rcm/core";
import { HttpError, route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const POST = route<{ id: string }>(async (_req, { params, user }) => {
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw new HttpError(404, "Run not found");
  const ok = await cancelRun(params.id);
  if (!ok) throw new HttpError(409, "Run already finished");
  await audit(user!.email, "cancel_run", "run", params.id);
  return { ok: true };
});
