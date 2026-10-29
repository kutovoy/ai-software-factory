'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Decision = 'approve' | 'reject' | 'request_changes';

/**
 * Gate decision form (spec: durable gates with SLA). Posts to the same-origin proxy, which
 * forwards the decision to `POST /work-items/:id/gates/:stage`; the API records it in the
 * read model and delivers it to the waiting stage child as a Temporal Update.
 *
 * `request_changes` requires feedback: the loop returns the item to the previous stage with
 * that text attached, so an empty feedback would be an unactionable loop.
 */
export function GateDecisionActions({
  workItemId,
  stage,
  slaLabel,
}: {
  workItemId: string;
  stage: string;
  slaLabel?: string;
}) {
  const router = useRouter();
  const [actor, setActor] = useState('local-user');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState<Decision | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (decision: Decision): Promise<void> => {
    setError(null);
    setResult(null);

    if (!actor.trim()) {
      setError('an actor is required');
      return;
    }
    if (decision === 'request_changes' && !feedback.trim()) {
      setError('request_changes needs feedback: the item returns to the previous stage with it');
      return;
    }

    setBusy(decision);
    try {
      const response = await fetch(
        `/api/work-items/${encodeURIComponent(workItemId)}/gates/${encodeURIComponent(stage)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            decision,
            actor: actor.trim(),
            ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
        delivery?: string;
        attempt?: number;
      };
      if (!response.ok) {
        throw new Error(body.message ?? body.code ?? `gate decision failed (${response.status})`);
      }
      setResult(
        `${decision} recorded for ${stage}${body.attempt ? ` (attempt ${body.attempt})` : ''}` +
          `${body.delivery ? ` · delivered: ${body.delivery}` : ''}`,
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
    <div
      data-testid="gate-actions"
      data-work-item-id={workItemId}
      data-stage={stage}
      className="space-y-2"
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          Actor
          <input
            data-testid="gate-actor"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            className="mt-1 block w-32 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        {slaLabel ? (
          <span data-testid="gate-sla" className="pb-1 font-mono text-[11px] text-slate-500">
            SLA {slaLabel}
          </span>
        ) : null}
      </div>

      <label className="block text-xs text-slate-600">
        Feedback (required for request_changes)
        <textarea
          data-testid="gate-feedback"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          rows={2}
          placeholder="What must change before this stage can pass?"
          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="gate-approve"
          disabled={busy !== null}
          onClick={() => void submit('approve')}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button
          type="button"
          data-testid="gate-reject"
          disabled={busy !== null}
          onClick={() => void submit('reject')}
          className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
        <button
          type="button"
          data-testid="gate-request-changes"
          disabled={busy !== null}
          onClick={() => void submit('request_changes')}
          className="rounded-md border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
        >
          {busy === 'request_changes' ? 'Requesting…' : 'Request changes'}
        </button>
      </div>

      {error ? (
        <p data-testid="gate-error" role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
      {result ? (
        <p data-testid="gate-result" className="text-xs text-emerald-700">
          {result}
        </p>
      ) : null}
    </div>
  );
}
