'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Work-item retry control (spec `factory-loop` › Work-item retry, `web-console` ›
 * Contextual run actions).
 *
 * A factory stage run cannot be retried on its own (`run_not_retryable`): retry belongs to
 * the work item. This control re-opens an escalated/failed/blocked/cancelled item at its
 * current stage, dispatches it again under a new attempt workflow id and reloads the page
 * from the read model. It is disabled while the request is in flight; the API also dedupes
 * a double submit within 60 seconds.
 */
export function RetryWorkItemButton({
  workItemId,
  status,
}: {
  workItemId: string;
  status: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [actor, setActor] = useState('local-user');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    if (!actor.trim()) {
      setError('an actor is required to retry a work item');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/work-items/${encodeURIComponent(workItemId)}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actor: actor.trim(),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
        attempt?: number;
      };
      if (!response.ok) {
        throw new Error(body.message ?? body.code ?? `retry failed (${response.status})`);
      }
      setOpen(false);
      setReason('');
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="work-item-retry" data-status={status} className="mt-1">
      {open ? (
        <div
          data-testid="work-item-retry-form"
          role="dialog"
          aria-modal="true"
          aria-label="Retry work item"
          className="space-y-1 rounded-lg border border-slate-300 bg-slate-50 p-3"
        >
          <p className="text-xs text-slate-600">
            Re-opens the item at <span className="font-mono">{status}</span> →{' '}
            <span className="font-mono">active</span> and dispatches the current stage again
            under a new attempt.
          </p>
          <label className="block text-xs text-slate-600">
            Actor
            <input
              data-testid="work-item-retry-actor"
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              className="mt-1 block w-40 rounded border border-slate-300 px-1.5 py-1 text-[11px]"
            />
          </label>
          <label className="block text-xs text-slate-600">
            Reason (optional, recorded in the audit)
            <input
              data-testid="work-item-retry-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why retry?"
              className="mt-1 block w-full rounded border border-slate-300 px-1.5 py-1 text-[11px]"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="work-item-retry-submit"
              disabled={busy}
              onClick={() => void submit()}
              className="rounded bg-slate-900 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Retrying…' : 'Retry work item'}
            </button>
            <button
              type="button"
              data-testid="work-item-retry-dismiss"
              onClick={() => setOpen(false)}
              className="text-[11px] text-slate-500 underline decoration-slate-300 underline-offset-2"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="work-item-retry-open"
          onClick={() => setOpen(true)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          Retry work item
        </button>
      )}
      {error ? (
        <p data-testid="work-item-retry-error" role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
