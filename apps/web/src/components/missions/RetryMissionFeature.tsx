'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Retry one failed mission feature (`POST /factories/:id/missions/:id/features/:featureId/retry`).
 *
 * Retry belongs to the feature, not to its work item: the mission scheduler owns dependency
 * order and the fix-feature loop, so re-opening a feature asks the orchestrator to dispatch
 * it again under a new attempt. The actor is recorded in the mission event log; the reason is
 * optional audit context.
 */
export function RetryMissionFeature({
  factoryId,
  missionId,
  featureId,
  featureTitle,
}: {
  factoryId: string;
  missionId: string;
  featureId: string;
  featureTitle: string;
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
      setError('an actor is required to retry a feature');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/factories/${encodeURIComponent(factoryId)}/missions/${encodeURIComponent(missionId)}/features/${encodeURIComponent(featureId)}/retry`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            actor: actor.trim(),
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
      if (!response.ok) {
        throw new Error(body.message ?? body.code ?? `feature retry failed (${response.status})`);
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
    <div data-testid="mission-feature-retry" data-feature-id={featureId} className="mt-1">
      {open ? (
        <div
          data-testid="mission-feature-retry-form"
          role="dialog"
          aria-modal="true"
          aria-label={`Retry feature ${featureTitle}`}
          className="space-y-1 rounded-lg border border-slate-300 bg-slate-50 p-2"
        >
          <p className="text-[11px] text-slate-600">
            Re-opens <span className="font-mono">{featureId}</span> for dispatch under a new
            attempt; dependencies are re-checked before it starts.
          </p>
          <label className="block text-[11px] text-slate-600">
            Actor
            <input
              data-testid="mission-feature-retry-actor"
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              className="mt-0.5 block w-40 rounded border border-slate-300 px-1.5 py-1 text-[11px]"
            />
          </label>
          <label className="block text-[11px] text-slate-600">
            Reason (optional, recorded in the audit)
            <input
              data-testid="mission-feature-retry-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why retry?"
              className="mt-0.5 block w-full rounded border border-slate-300 px-1.5 py-1 text-[11px]"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="mission-feature-retry-submit"
              disabled={busy}
              onClick={() => void submit()}
              className="rounded bg-slate-900 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Retrying…' : 'Retry feature'}
            </button>
            <button
              type="button"
              data-testid="mission-feature-retry-dismiss"
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
          data-testid="mission-feature-retry-open"
          onClick={() => setOpen(true)}
          className="text-[11px] font-medium text-slate-700 underline decoration-slate-300 underline-offset-2"
        >
          Retry feature…
        </button>
      )}
      {error ? (
        <p data-testid="mission-feature-retry-error" role="alert" className="text-[11px] text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
