export function ago(d: string | Date | null | undefined): string {
  if (!d) return "–";
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 0) return "in " + fmtDur(-s);
  if (s < 5) return "just now";
  return fmtDur(s) + " ago";
}
function fmtDur(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
export const scoreClass = (n: number) => (n >= 60 ? "s-hi" : n >= 35 ? "s-mid" : "s-lo");
export const statusBadge = (s: string) =>
  ({ succeeded: "ok", sent: "ok", approved: "info", running: "info", queued: "warn", draft: "warn", failed: "bad", cancelled: "", rejected: "" } as Record<string, string>)[s] ?? "";
