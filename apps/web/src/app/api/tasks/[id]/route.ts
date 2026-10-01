import { z } from "zod";
import { updateTask } from "@rcm/core";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";
const Patch = z.object({ status: z.enum(["open", "done", "dismissed"]).optional(), snoozeDays: z.number().min(0).max(3650).optional(), title: z.string().max(300).optional(), notes: z.string().max(2000).optional() });

export const PATCH = route<{ id: string }>(async (req, { params, user }) => {
  const b = Patch.parse(await body(req));
  const dueAt = b.snoozeDays !== undefined ? new Date(Date.now() + b.snoozeDays * 86400_000) : undefined;
  return { task: await updateTask(params.id, { status: b.status, dueAt, title: b.title, notes: b.notes }, user!.email) };
});
