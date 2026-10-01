import { z } from "zod";
import { updateDeal } from "@rcm/core";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";
const Patch = z.object({ name: z.string().max(200).optional(), valueUsd: z.number().min(0).max(1e9).optional(), expectedClose: z.string().nullable().optional(), notes: z.string().max(2000).optional(), status: z.enum(["open", "won", "lost"]).optional() });
export const PATCH = route<{ id: string }>(async (req, { params, user }) => ({ deal: await updateDeal(params.id, Patch.parse(await body(req)), user!.email) }));
