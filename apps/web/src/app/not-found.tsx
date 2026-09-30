import Link from "next/link";
export default function NotFound() {
  return (
    <div className="center">
      <div className="card narrow">
        <h1>Page not found</h1>
        <p className="muted">That page does not exist, or the record was removed.</p>
        <Link className="btn primary" href="/">Back to the dashboard</Link>
      </div>
    </div>
  );
}
