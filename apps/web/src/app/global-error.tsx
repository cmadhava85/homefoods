"use client";

// Replaces the root layout when it fails, so no providers/CSS are available — keep it self-contained.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          display: "grid",
          placeItems: "center",
          minHeight: "100vh",
          margin: 0,
          padding: "1rem",
          background: "#e4ece7",
          color: "#0c1a14",
        }}
      >
        <main style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: "1.4rem" }}>LocalMeals is having trouble</h1>
          <p>Your order and payment are safe. Please try again in a minute.</p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "0.6rem 1.2rem",
              borderRadius: 999,
              border: "none",
              background: "#0d5840",
              color: "#fff",
              fontSize: "1rem",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest ? <p style={{ opacity: 0.6, fontSize: "0.8rem" }}>Reference: {error.digest}</p> : null}
        </main>
      </body>
    </html>
  );
}
