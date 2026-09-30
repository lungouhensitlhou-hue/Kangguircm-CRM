import { getRun, listEvents } from "@rcm/core";
import { HttpError, route } from "@/lib/api";

export const dynamic = "force-dynamic";

const DONE = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Live progress. Default: Server-Sent Events, closing when the run finishes.
 * `?format=json&after=<id>` returns a plain JSON page (used by tests and as a fallback).
 */
export const GET = route<{ id: string }>(async (req, { params }) => {
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw new HttpError(404, "Run not found");
  const run = await getRun(params.id);
  if (!run) throw new HttpError(404, "Run not found");
  const url = new URL(req.url);
  const after = Number(url.searchParams.get("after") ?? req.headers.get("last-event-id") ?? 0) || 0;
  if (url.searchParams.get("format") === "json") return { run, events: await listEvents(run.id, after) };

  const enc = new TextEncoder();
  let last = after;
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown, id?: number) =>
        controller.enqueue(enc.encode(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      req.signal.addEventListener("abort", () => { closed = true; });
      const started = Date.now();
      while (!closed && Date.now() - started < 10 * 60_000) {
        const evs = await listEvents(run.id, last);
        for (const e of evs) { send("event", e, e.id); last = e.id; }
        const cur = await getRun(run.id);
        if (cur && DONE.has(cur.status) && (await listEvents(run.id, last)).length === 0) { send("done", { status: cur.status, output: cur.output, error: cur.error }); break; }
        controller.enqueue(enc.encode(": keepalive\n\n"));
        await new Promise((r) => setTimeout(r, 700));
      }
      try { controller.close(); } catch { /* already closed */ }
    },
    cancel() { closed = true; },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
});
