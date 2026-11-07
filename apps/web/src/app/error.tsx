'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary. Pages that fetch a detail projection with `apiGet` throw on
 * a 5xx/network failure; without this boundary Next would replace the page with its default
 * error screen. The shell (sidebar + connection banner) stays mounted and the user gets a
 * retry instead of a white page.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('route render failed', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <div
        data-testid="route-error"
        role="alert"
        className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-amber-950 shadow-sm"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
          Console error
        </p>
        <h1 className="mt-1 text-lg font-semibold">Server connection issue</h1>
        <p className="mt-2 text-sm text-amber-800">
          The console could not reach the API or render this page. Your session and data are
          untouched; retry when the backend is available again.
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-[11px] text-amber-700">digest: {error.digest}</p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-300"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-sm font-semibold text-amber-900 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-400/50"
          >
            Reload page
          </button>
          <a
            href="/chat"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-300"
          >
            Go to New Chat
          </a>
        </div>
      </div>
    </div>
  );
}
