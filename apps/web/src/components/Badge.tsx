import { statusBadge } from "@/lib/format";
export function Badge({ children, kind }: { children: React.ReactNode; kind?: string }) {
  return <span className={`badge ${kind ?? ""}`}>{children}</span>;
}
export function StatusBadge({ status }: { status: string }) {
  return <Badge kind={statusBadge(status)}>{status}</Badge>;
}
