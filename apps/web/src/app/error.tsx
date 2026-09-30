"use client";
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="center">
      <div className="card narrow">
        <h1>Something went wrong</h1>
        <p className="muted">The page hit an unexpected error. Your data is safe. Try again; if it keeps happening, open Settings → Connection test, or check the server logs{error.digest ? ` (reference ${error.digest})` : ""}.</p>
        <div className="row"><button className="primary" onClick={reset}>Try again</button><a className="btn" href="/">Dashboard</a></div>
      </div>
    </div>
  );
}
