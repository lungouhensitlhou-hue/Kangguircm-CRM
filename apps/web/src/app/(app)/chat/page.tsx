import { query } from "@rcm/core";
import { Chat } from "@/components/Chat";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const msgs = await query<any>("SELECT id, role, content, created_at FROM chat_messages WHERE thread_id = 'default' ORDER BY created_at, role DESC LIMIT 200");
  return (
    <>
      <div className="head"><div><h1>Ask your agents</h1><div className="muted">Command the CRM in plain English. Agents can research and draft, but never send: you approve every email.</div></div></div>
      <Chat initial={msgs.map((m) => ({ ...m, created_at: String(m.created_at) }))} hasLlm={!!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN} />
    </>
  );
}
