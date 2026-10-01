import Link from "next/link";
import { listTasks, taskCounts, type TaskBucket } from "@rcm/core";
import { AddTask, TaskList } from "@/components/TaskList";

export const dynamic = "force-dynamic";
const TABS: [TaskBucket, string][] = [["all", "Open"], ["overdue", "Overdue"], ["today", "Today"], ["upcoming", "Upcoming"], ["done", "Done"]];

export default async function Tasks({ searchParams }: { searchParams: Promise<{ bucket?: string }> }) {
  const { bucket } = await searchParams;
  const b = (TABS.some(([k]) => k === bucket) ? bucket : "all") as TaskBucket;
  const [tasks, counts] = await Promise.all([listTasks({ bucket: b, limit: 300 }), taskCounts()]);
  return (
    <>
      <div className="head"><div><h1>Tasks</h1><div className="muted">{counts.overdue} overdue · {counts.today} due today · {counts.upcoming} upcoming. Replies and stuck leads create tasks automatically.</div></div></div>
      <div className="tabs">{TABS.map(([k, label]) => <Link key={k} href={k === "all" ? "/tasks" : `/tasks?bucket=${k}`} className={b === k ? "active" : ""}>{label}</Link>)}</div>
      <div className="card" style={{ marginBottom: 14 }}><TaskList tasks={tasks as any} empty={b === "done" ? "No completed tasks yet." : "No tasks here. Nice."} /></div>
      <div className="card"><AddTask /></div>
    </>
  );
}
