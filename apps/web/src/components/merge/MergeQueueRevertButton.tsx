'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Manual revert (spec `merge-queue` › manual revert). The batch is reverted regardless of
 * checks; the action carries an actor + reason and lands in `merge.reverted`.
 */
export function MergeQueueRevertButton({
  factoryId,
  batchId,
}: {
  factoryId: string;
  batchId: string;
}) {
  const router = useRouter();
  const [actor, setActor] = useState('local-user');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    if (!actor.trim() || !reason.trim()) {
      setError('an actor and a reason are required');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/factories/${encodeURIComponent(factoryId)}/merge-queue/revert`,
        {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          batchId,
          actor: actor.trim(),
          reason: reason.trim(),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
      };
      if (!response.ok) {
        throw new Error(payload.message ?? payload.code ?? `request failed (${response.status})`);
      }
      setNotice('Revert queued — the worker restores the pre-batch tree.');
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 space-y-1">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[11px] text-slate-600">
          Actor
          <input
            data-testid="merge-revert-actor"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            className="mt-0.5 block w-28 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900"
          />
        </label>
        <label className="text-[11px] text-slate-600">
          Reason
          <input
            data-testid="merge-revert-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="mt-0.5 block w-48 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900"
          />
        </label>
        <button
          type="button"
          data-testid="merge-revert-button"
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 disabled:opacity-50"
        >
          {busy ? 'Reverting…' : 'Revert batch'}
        </button>
      </div>
      {error ? (
        <p data-testid="merge-revert-error" className="text-[11px] text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p data-testid="merge-revert-notice" className="text-[11px] text-emerald-700">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
