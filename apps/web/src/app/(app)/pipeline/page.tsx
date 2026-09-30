import { query } from "@rcm/core";
import { Kanban, type Card } from "@/components/Kanban";

export const dynamic = "force-dynamic";

export default async function Pipeline() {
  const cards = await query<Card>(
    `SELECT l.id, l.stage, l.score, o.name, o.specialty, o.city, o.state
     FROM leads l JOIN organizations o ON o.id = l.organization_id ORDER BY l.score DESC, l.updated_at DESC LIMIT 600`,
  );
  return (
    <>
      <div className="head"><div><h1>Pipeline</h1><div className="muted">Drag cards between stages, or use the dropdown on each card. Showing top 600 by score.</div></div></div>
      <Kanban cards={cards} />
    </>
  );
}
