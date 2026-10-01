import { z } from "zod";
import { MERGE_FIELDS, createTemplate, listTemplates } from "@rcm/core";
import { body, json, route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route(async () => ({ templates: await listTemplates(), fields: MERGE_FIELDS }));
export const POST = route(async (req) => json(await createTemplate(z.object({ name: z.string().min(1).max(100), subject: z.string().min(1).max(200), body: z.string().min(1).max(5000) }).parse(await body(req))), 201));
