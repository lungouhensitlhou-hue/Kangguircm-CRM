import { z } from "zod";
import { listViews, saveView } from "@rcm/core";
import { body, json, route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route(async () => ({ views: await listViews() }));
export const POST = route(async (req) => {
  const b = z.object({ name: z.string().min(1).max(60), filters: z.record(z.string(), z.any()) }).parse(await body(req));
  return json(await saveView(b.name, b.filters), 201);
});
