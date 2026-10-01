import { dueCount, queryOne } from "@rcm/core";
import { Nav } from "@/components/Nav";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const row = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM messages WHERE status = 'draft' AND direction = 'outbound'");
  const tasksDue = await dueCount();
  return (
    <div className="shell">
      <Nav pending={row?.n ?? 0} tasksDue={tasksDue} email={user.email} />
      <main className="main">{children}</main>
    </div>
  );
}
