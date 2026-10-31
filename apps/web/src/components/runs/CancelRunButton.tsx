'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function CancelRunButton({ runId, disabled }: { runId: string; disabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'cancelled from console' }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `cancel failed (${response.status})`);
      }
      router.refresh();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        data-testid="run-cancel"
        disabled={disabled || busy}
        onClick={() => void cancel()}
        className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-200 disabled:opacity-50"
      >
        {busy ? 'Cancelling…' : 'Cancel run'}
      </button>
      {error ? (
        <span data-testid="run-cancel-error" role="alert" className="text-xs text-red-600">
          {error}
        </span>
      ) : null}
    </div>
  );
}
