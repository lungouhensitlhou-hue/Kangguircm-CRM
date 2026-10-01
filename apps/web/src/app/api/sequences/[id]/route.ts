import { z } from "zod";
import { deleteSequence, updateSequence } from "@rcm/core";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";
const Patch = z.object({ name: z.string().max(100).optional(), steps: z.array(z.object({ delayDays: z.number(), templateIds: z.array(z.string()).optional() })).max(8).optional(), isDefault: z.boolean().optional() });
export const PATCH = route<{ id: string }>(async (req, { params }) => ({ sequence: await updateSequence(params.id, Patch.parse(await body(req))) }));
export const DELETE = route<{ id: string }>(async (_req, { params }) => { await deleteSequence(params.id); return { ok: true }; });
