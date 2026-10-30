'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Work-item cancel control (harden-runtime, task 1.4). Posts actor + reason to
 * `POST /work-items/:id/cancel` through the same-origin proxy; the API records the request,
 * Signals the workflow, and the item ends `cancelled`. The board re-renders from the read
 * model, so nothing is inferred locally.
 */
export function CancelWorkItemButton({
  workItemId,
  status,
  cancelRequestedAt,
}: {
  workItemId: string;
  status: string;
  cancelRequestedAt?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [actor, setActor] = useState('local-user');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'done' || status === 'cancelled') {
    return cancelRequestedAt ? (
      <p data-testid="work-item-cancel-requested" className="mt-1 font-mono text-[10px] text-amber-700">
        cancel requested {cancelRequestedAt}
      </p>
    ) : null;
  }

  const submit = async (): Promise<void> => {
    setError(null);
    if (!actor.trim() || !reason.trim()) {
      setError('actor and reason are required to cancel a work item');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/work-items/${encodeURIComponent(workItemId)}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: actor.trim(), reason: reason.trim() }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
      if (!response.ok) {
        throw new Error(body.message ?? body.code ?? `cancel failed (${response.status})`);
      }
      setOpen(false);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1">
      {cancelRequestedAt ? (
        <p data-testid="work-item-cancel-requested" className="font-mono text-[10px] text-amber-700">
          cancel requested {cancelRequestedAt}
        </p>
      ) : null}
      {open ? (
        <div data-testid="work-item-cancel-form" className="mt-1 space-y-1">
          <input
            data-testid="work-item-cancel-actor"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            aria-label="Cancel actor"
            className="w-full rounded border border-slate-300 px-1.5 py-1 text-[11px]"
          />
          <input
            data-testid="work-item-cancel-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why cancel?"
            aria-label="Cancel reason"
            className="w-full rounded border border-slate-300 px-1.5 py-1 text-[11px]"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="work-item-cancel-submit"
              disabled={busy}
              onClick={() => void submit()}
              className="rounded bg-red-600 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Cancelling…' : 'Confirm cancel'}
            </button>
            <button
              type="button"
              data-testid="work-item-cancel-dismiss"
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
          data-testid="work-item-cancel-open"
          onClick={() => setOpen(true)}
          className="text-[11px] font-medium text-red-700 underline decoration-red-200 underline-offset-2"
        >
          Cancel item…
        </button>
      )}
      {error ? (
        <p data-testid="work-item-cancel-error" role="alert" className="text-[11px] text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
