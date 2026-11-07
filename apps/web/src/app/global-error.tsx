'use client';

/**
 * Last-resort boundary for a failure in the root layout (including the auth/session read).
 * Next requires its own `<html>`/`<body>` here, so the styling is inline: the global
 * stylesheet may not have loaded when this renders. The goal is never a blank page.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          background: '#f8fafc',
          color: '#0f172a',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <main
          data-testid="global-error"
          style={{ maxWidth: '42rem', margin: '0 auto', padding: '4rem 1.5rem' }}
        >
          <div
            role="alert"
            style={{
              border: '1px solid #fcd34d',
              background: '#fffbeb',
              borderRadius: '0.75rem',
              padding: '1.5rem',
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: '0.75rem',
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: '#b45309',
              }}
            >
              Console error
            </p>
            <h1 style={{ margin: '0.25rem 0 0', fontSize: '1.25rem' }}>
              Server connection issue
            </h1>
            <p style={{ margin: '0.75rem 0 0', fontSize: '0.875rem', color: '#92400e' }}>
              The console could not render its shell because the API or web server is
              restarting. Your data is untouched. Retry when the backend is available again.
            </p>
            {error.digest ? (
              <p style={{ margin: '0.5rem 0 0', fontSize: '0.7rem', color: '#b45309' }}>
                digest: {error.digest}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                marginTop: '1rem',
                border: 0,
                borderRadius: '0.375rem',
                background: '#0f172a',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '0.875rem',
                fontWeight: 600,
                padding: '0.4rem 0.8rem',
              }}
            >
              Retry
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
