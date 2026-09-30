import { z } from "zod";
import { getRun, postChatMessage, query } from "@rcm/core";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";
const THREAD = "default";

export const GET = route(async (req) => {
  const after = new URL(req.url).searchParams.get("after");
  const messages = await query(
    `SELECT m.id, m.role, m.content, m.created_at, m.run_id FROM chat_messages m
     WHERE m.thread_id = $1 ${after ? "AND m.created_at > $2::timestamptz" : ""} ORDER BY m.created_at, m.role DESC LIMIT 200`,
    after ? [THREAD, after] : [THREAD],
  );
  const pending = await query("SELECT id FROM agent_runs WHERE kind = 'chat' AND status IN ('queued','running')");
  return { messages, pending: pending.length > 0 };
});

export const POST = route(async (req, { user }) => {
  const { message } = z.object({ message: z.string().min(1).max(4000) }).parse(await body(req));
  return postChatMessage(THREAD, message, user!.email);
});
