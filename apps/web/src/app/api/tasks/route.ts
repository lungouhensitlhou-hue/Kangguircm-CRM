import { z } from "zod";
import { TASK_KINDS, createTask, getLead, listTasks, taskCounts } from "@rcm/core";
import { HttpError, body, json, route } from "@/lib/api";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const p = new URL(req.url).searchParams;
  return { tasks: await listTasks({ bucket: (p.get("bucket") as any) ?? "all", leadId: p.get("leadId") ?? undefined }), counts: await taskCounts() };
});

const Create = z.object({ title: z.string().min(1).max(300), leadId: z.string().uuid().optional(), kind: z.enum(TASK_KINDS).optional(), dueInDays: z.number().min(0).max(3650).optional(), notes: z.string().max(2000).optional() });
export const POST = route(async (req, { user }) => {
  const b = Create.parse(await body(req));
  if (b.leadId && !(await getLead(b.leadId))) throw new HttpError(404, "Lead not found");
  const t = await createTask({ leadId: b.leadId, title: b.title, kind: b.kind, notes: b.notes, dueAt: new Date(Date.now() + (b.dueInDays ?? 0) * 86400_000), source: "manual", createdBy: user!.email });
  return json(t, 201);
});
