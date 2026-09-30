"use client";
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ font: "14px system-ui", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0 }}>
        <div style={{ maxWidth: 420, padding: 24 }}>
          <h1>Something went wrong</h1>
          <p>The app hit an unexpected error. Your data is safe. Try again, and if it persists check the server logs.</p>
          <button onClick={reset}>Try again</button>
        </div>
      </body>
    </html>
  );
}
