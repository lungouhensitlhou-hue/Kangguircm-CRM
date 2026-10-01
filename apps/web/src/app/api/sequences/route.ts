import { z } from "zod";
import { createSequence, listSequences } from "@rcm/core";
import { body, json, route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const Steps = z.array(z.object({ delayDays: z.number(), templateIds: z.array(z.string()).optional() })).max(8);
export const GET = route(async () => ({ sequences: await listSequences() }));
export const POST = route(async (req) => json(await createSequence(z.object({ name: z.string().min(1).max(100), steps: Steps, isDefault: z.boolean().optional() }).parse(await body(req))), 201));
