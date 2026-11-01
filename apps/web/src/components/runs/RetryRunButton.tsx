'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Retry control (spec `web-console` › Retry control). Creates a *new* run from the original
 * input; the original run stays immutable. Disabled while the request is in flight so a
 * double click cannot start two runs (the API also dedupes within 60s).
 */
export function RetryRunButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/retry`, {
        method: 'POST',
      });
      const payload = (await response.json().catch(() => null)) as
        | { run?: { id?: string }; message?: string; code?: string }
        | null;
      if (!response.ok) {
        setError(payload?.message ?? `retry failed (${response.status})`);
        setPending(false);
        return;
      }
      const nextId = payload?.run?.id;
      if (!nextId) {
        setError('the API did not return the new run id');
        setPending(false);
        return;
      }
      router.push(`/runs/${encodeURIComponent(nextId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        data-testid="run-retry-button"
        onClick={retry}
        disabled={pending}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-slate-300"
      >
        {pending ? 'Starting retry…' : 'Retry as new run'}
      </button>
      {error ? (
        <p data-testid="run-retry-error" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
