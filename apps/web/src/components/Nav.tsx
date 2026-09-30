"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const ITEMS = [
  ["/", "Dashboard"], ["/leads", "Leads"], ["/pipeline", "Pipeline"], ["/approvals", "Approvals"], ["/runs", "Agent runs"], ["/chat", "Ask agents"], ["/settings", "Settings"],
] as const;

export function Nav({ pending, email }: { pending: number; email: string }) {
  const path = usePathname();
  const router = useRouter();
  return (
    <aside className="side">
      <div className="brand">Kangguircm RCM</div>
      <nav className="nav">
        {ITEMS.map(([href, label]) => (
          <Link key={href} href={href} className={href === "/" ? (path === "/" ? "active" : "") : path.startsWith(href) ? "active" : ""}>
            {label}
            {href === "/approvals" && pending > 0 ? <span className="badge warn">{pending}</span> : null}
          </Link>
        ))}
      </nav>
      <div style={{ marginTop: "auto" }} className="small muted">
        <div style={{ padding: "0 10px 8px", wordBreak: "break-all" }}>{email}</div>
        <button className="sm" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); router.push("/login"); router.refresh(); }}>Sign out</button>
      </div>
    </aside>
  );
}
