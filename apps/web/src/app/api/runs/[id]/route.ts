import { getRun } from "@rcm/core";
import { HttpError, route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route<{ id: string }>(async (_req, { params }) => {
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw new HttpError(404, "Run not found");
  const run = await getRun(params.id);
  if (!run) throw new HttpError(404, "Run not found");
  return { run };
});
