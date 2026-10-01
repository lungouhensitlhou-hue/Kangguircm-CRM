import { deleteView } from "@rcm/core";
import { route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const DELETE = route<{ id: string }>(async (_req, { params }) => { await deleteView(params.id); return { ok: true }; });
