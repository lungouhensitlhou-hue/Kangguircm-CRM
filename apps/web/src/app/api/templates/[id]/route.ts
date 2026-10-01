import { z } from "zod";
import { deleteTemplate, updateTemplate } from "@rcm/core";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const PATCH = route<{ id: string }>(async (req, { params }) => ({ template: await updateTemplate(params.id, z.object({ name: z.string().max(100).optional(), subject: z.string().max(200).optional(), body: z.string().max(5000).optional(), active: z.boolean().optional() }).parse(await body(req))) }));
export const DELETE = route<{ id: string }>(async (_req, { params }) => { await deleteTemplate(params.id); return { ok: true }; });
