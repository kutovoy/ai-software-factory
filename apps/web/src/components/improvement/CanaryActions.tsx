'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Manual canary controls. Rollback works regardless of the window (routing returns to
 * stable immediately); promotion merges the candidate PR. Both are audited with the actor
 * and reason supplied here.
 */
export function CanaryActions({
  factory,
  rolloutId,
  active,
}: {
  factory: string;
  rolloutId: string;
  active: boolean;
}) {
  const router = useRouter();
  const [actor, setActor] = useState('local-user');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'promote' | 'rollback' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (action: 'promote' | 'rollback'): Promise<void> => {
    setError(null);
    setNotice(null);
    if (!actor.trim() || !reason.trim()) {
      setError('an actor and a reason are required');
      return;
    }
    setBusy(action);
    try {
      const response = await fetch(`/api/canary/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          factory,
          rolloutId,
          actor: actor.trim(),
          reason: reason.trim(),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
        mergedCommit?: string | null;
      };
      if (!response.ok) {
        throw new Error(payload.message ?? payload.code ?? `request failed (${response.status})`);
      }
      setNotice(
        action === 'promote'
          ? `Promoted${payload.mergedCommit ? ` — merged ${payload.mergedCommit.slice(0, 8)}` : ''}.`
          : 'Rolled back — new work returns to the stable version.',
      );
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          Actor
          <input
            data-testid="canary-actor"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            className="mt-1 block w-36 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
          />
        </label>
        <label className="flex-1 text-xs text-slate-600">
          Reason
          <input
            data-testid="canary-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="why this rollout should promote or roll back"
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          data-testid="canary-promote"
          type="button"
          disabled={!active || busy !== null}
          onClick={() => void submit('promote')}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy === 'promote' ? 'Promoting…' : 'Promote candidate'}
        </button>
        <button
          data-testid="canary-rollback"
          type="button"
          disabled={!active || busy !== null}
          onClick={() => void submit('rollback')}
          className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-900 disabled:opacity-40"
        >
          {busy === 'rollback' ? 'Rolling back…' : 'Roll back to stable'}
        </button>
      </div>
      {error ? (
        <p data-testid="canary-action-error" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p data-testid="canary-action-notice" className="text-xs text-emerald-800">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
