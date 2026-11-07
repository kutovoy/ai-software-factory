'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type PlanDecision = 'approve' | 'reject' | 'request_changes';

/**
 * Mission plan gate (`POST /factories/:id/missions/:missionId/gates/plan`).
 *
 * The plan carries the validation contract and the milestone/feature decomposition, so a
 * decision here is what unlocks feature dispatch. `request_changes` requires feedback: the
 * planner replans from it, and an empty feedback would be an unactionable loop. `reject`
 * ends the mission without dispatching anything.
 */
export function MissionPlanDecisionActions({
  factoryId,
  missionId,
}: {
  factoryId: string;
  missionId: string;
}) {
  const router = useRouter();
  const [actor, setActor] = useState('local-user');
  const [reason, setReason] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState<PlanDecision | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (decision: PlanDecision): Promise<void> => {
    setError(null);
    setResult(null);

    if (!actor.trim()) {
      setError('an actor is required');
      return;
    }
    if (decision === 'request_changes' && !feedback.trim()) {
      setError('request_changes needs feedback: the planner replans from it');
      return;
    }

    setBusy(decision);
    try {
      const response = await fetch(
        `/api/v1/factories/${encodeURIComponent(factoryId)}/missions/${encodeURIComponent(missionId)}/gates/plan`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            decision,
            actor: actor.trim(),
            ...(reason.trim() ? { reason: reason.trim() } : {}),
            ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
        delivery?: string;
      };
      if (!response.ok) {
        throw new Error(body.message ?? body.code ?? `plan decision failed (${response.status})`);
      }
      setResult(
        `${decision} recorded for the plan${body.delivery ? ` · delivered: ${body.delivery}` : ''}`,
      );
      setFeedback('');
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="mission-plan-actions" data-mission-id={missionId} className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          Actor
          <input
            data-testid="mission-plan-actor"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            className="mt-1 block w-32 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="min-w-[12rem] flex-1 text-xs text-slate-600">
          Reason (optional)
          <input
            data-testid="mission-plan-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why this decision?"
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
      </div>

      <label className="block text-xs text-slate-600">
        Feedback (required for request_changes)
        <textarea
          data-testid="mission-plan-feedback"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          rows={2}
          placeholder="What must the plan change before features can start?"
          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="mission-plan-approve"
          disabled={busy !== null}
          onClick={() => void submit('approve')}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy === 'approve' ? 'Approving…' : 'Approve plan'}
        </button>
        <button
          type="button"
          data-testid="mission-plan-reject"
          disabled={busy !== null}
          onClick={() => void submit('reject')}
          className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          {busy === 'reject' ? 'Rejecting…' : 'Reject plan'}
        </button>
        <button
          type="button"
          data-testid="mission-plan-request-changes"
          disabled={busy !== null}
          onClick={() => void submit('request_changes')}
          className="rounded-md border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
        >
          {busy === 'request_changes' ? 'Requesting…' : 'Request changes'}
        </button>
      </div>

      {error ? (
        <p data-testid="mission-plan-error" role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
      {result ? (
        <p data-testid="mission-plan-result" className="text-xs text-emerald-700">
          {result}
        </p>
      ) : null}
    </div>
  );
}
