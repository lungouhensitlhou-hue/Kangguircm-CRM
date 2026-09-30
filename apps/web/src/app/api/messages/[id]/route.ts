import { z } from "zod";
import { approveMessage, editDraft, rejectMessage } from "@rcm/core";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";
const P = z.object({ action: z.enum(["approve", "reject", "edit"]), subject: z.string().max(200).optional(), body: z.string().max(5000).optional() });

export const PATCH = route<{ id: string }>(async (req, { params, user }) => {
  const b = P.parse(await body(req));
  const actor = user!.email;
  if (b.action === "edit") return { message: await editDraft(params.id, { subject: b.subject, body: b.body }, actor) };
  if (b.action === "reject") { await rejectMessage(params.id, actor); return { ok: true }; }
  if (b.subject !== undefined || b.body !== undefined) await editDraft(params.id, { subject: b.subject, body: b.body }, actor);
  return { message: await approveMessage(params.id, actor) };
});
