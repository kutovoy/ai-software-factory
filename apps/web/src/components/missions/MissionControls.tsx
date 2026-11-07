'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type ControlAction = 'pause' | 'resume' | 'cancel';

/**
 * Mission lifecycle controls (`POST /factories/:id/missions/:id/pause|resume|cancel`).
 *
 * Pause stops new feature/validation dispatch; resume restarts the scheduler; cancel is
 * terminal and requires a reason (it is the one action that cannot be undone). A control is
 * only rendered when the mission's status allows it, so the page never shows a dead button.
 */
export function MissionControls({
  factoryId,
  missionId,
  status,
}: {
  factoryId: string;
  missionId: string;
  status: string;
}) {
  const router = useRouter();
  const [actor, setActor] = useState('local-user');
  const [reason, setReason] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState<ControlAction | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const terminal = status === 'done' || status === 'failed' || status === 'cancelled';
  const canPause = status === 'running';
  const canResume = status === 'paused';
  const canCancel = !terminal;

  const submit = async (action: ControlAction): Promise<void> => {
    setError(null);
    setResult(null);
    if (!actor.trim()) {
      setError('an actor is required');
      return;
    }
    if (action === 'cancel' && !reason.trim()) {
      setError('a reason is required to cancel a mission');
      return;
    }

    setBusy(action);
    try {
      const response = await fetch(
        `/api/v1/factories/${encodeURIComponent(factoryId)}/missions/${encodeURIComponent(missionId)}/${action}`,
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
        throw new Error(body.message ?? body.code ?? `${action} failed (${response.status})`);
      }
      setResult(`${action} recorded`);
      if (action === 'cancel') setConfirmCancel(false);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(null);
    }
  };

  if (!canPause && !canResume && !canCancel) {
    return (
      <p data-testid="mission-controls-terminal" className="text-xs text-slate-500">
        This mission is <span className="font-mono">{status}</span>; no lifecycle control applies.
      </p>
    );
  }

  return (
    <div data-testid="mission-controls" data-status={status} className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          Actor
          <input
            data-testid="mission-control-actor"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            className="mt-1 block w-32 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="min-w-[12rem] flex-1 text-xs text-slate-600">
          Reason {canCancel ? '(required to cancel)' : '(optional)'}
          <input
            data-testid="mission-control-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={canCancel ? 'Why pause/resume/cancel?' : 'Why pause/resume?'}
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {canPause ? (
          <button
            type="button"
            data-testid="mission-pause"
            disabled={busy !== null}
            onClick={() => void submit('pause')}
            className="rounded-md border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
          >
            {busy === 'pause' ? 'Pausing…' : 'Pause mission'}
          </button>
        ) : null}
        {canResume ? (
          <button
            type="button"
            data-testid="mission-resume"
            disabled={busy !== null}
            onClick={() => void submit('resume')}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy === 'resume' ? 'Resuming…' : 'Resume mission'}
          </button>
        ) : null}
        {canCancel ? (
          confirmCancel ? (
            <span className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="mission-cancel-submit"
                disabled={busy !== null}
                onClick={() => void submit('cancel')}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy === 'cancel' ? 'Cancelling…' : 'Confirm cancel'}
              </button>
              <button
                type="button"
                data-testid="mission-cancel-dismiss"
                onClick={() => setConfirmCancel(false)}
                className="text-xs text-slate-500 underline decoration-slate-300 underline-offset-2"
              >
                Dismiss
              </button>
            </span>
          ) : (
            <button
              type="button"
              data-testid="mission-cancel-open"
              onClick={() => setConfirmCancel(true)}
              className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
            >
              Cancel mission…
            </button>
          )
        ) : null}
      </div>

      {error ? (
        <p data-testid="mission-control-error" role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
      {result ? (
        <p data-testid="mission-control-result" className="text-xs text-emerald-700">
          {result}
        </p>
      ) : null}
    </div>
  );
}
