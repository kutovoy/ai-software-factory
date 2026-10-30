'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CanaryPruneResponseWire } from '@/lib/types';

/**
 * Candidate-tree prune control (harden-runtime, task 5.4). Terminal rollouts keep the last
 * N trees; an in-flight rollout's tree is never removed (the API reports `protected`).
 */
export function CanaryPruneButton({ factory }: { factory: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [actor, setActor] = useState('local-user');
  const [reason, setReason] = useState('');
  const [keep, setKeep] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CanaryPruneResponseWire | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    if (!actor.trim() || !reason.trim()) {
      setError('actor and reason are required to prune candidate trees');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/factories/${encodeURIComponent(factory)}/canary/prune`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actor: actor.trim(),
          reason: reason.trim(),
          ...(keep.trim() === '' ? {} : { keep: Number(keep) }),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as
        | CanaryPruneResponseWire
        | { message?: string; code?: string };
      if (!response.ok) {
        const failure = body as { message?: string; code?: string };
        throw new Error(failure.message ?? failure.code ?? `prune failed (${response.status})`);
      }
      setResult(body as CanaryPruneResponseWire);
      setOpen(false);
      router.refresh();
    } catch (pruneError) {
      setError(pruneError instanceof Error ? pruneError.message : String(pruneError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="canary-prune" className="space-y-1">
      {open ? (
        <div className="flex flex-wrap items-end gap-2 rounded border border-slate-200 bg-white px-2 py-2 text-[11px]">
          <label className="text-slate-600">
            Actor
            <input
              data-testid="canary-prune-actor"
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              className="mt-0.5 block w-28 rounded border border-slate-300 px-1.5 py-1"
            />
          </label>
          <label className="text-slate-600">
            Reason
            <input
              data-testid="canary-prune-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="mt-0.5 block w-48 rounded border border-slate-300 px-1.5 py-1"
            />
          </label>
          <label className="text-slate-600">
            Keep
            <input
              data-testid="canary-prune-keep"
              value={keep}
              onChange={(event) => setKeep(event.target.value)}
              placeholder="default"
              inputMode="numeric"
              className="mt-0.5 block w-20 rounded border border-slate-300 px-1.5 py-1"
            />
          </label>
          <button
            type="button"
            data-testid="canary-prune-submit"
            disabled={busy}
            onClick={() => void submit()}
            className="rounded bg-slate-900 px-2 py-1 font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'Pruning…' : 'Prune'}
          </button>
          <button
            type="button"
            data-testid="canary-prune-dismiss"
            onClick={() => setOpen(false)}
            className="text-slate-500 underline decoration-slate-300 underline-offset-2"
          >
            Dismiss
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="canary-prune-open"
          onClick={() => setOpen(true)}
          className="text-[11px] font-medium text-slate-700 underline decoration-slate-300 underline-offset-2"
        >
          Prune candidate trees…
        </button>
      )}

      {result ? (
        <p data-testid="canary-prune-result" className="text-[11px] text-slate-600">
          keep {result.keep} · removed {result.removed.length} · kept {result.kept.length} · protected{' '}
          {result.protected.length} (in-flight trees are never removed)
        </p>
      ) : null}
      {error ? (
        <p data-testid="canary-prune-error" role="alert" className="text-[11px] text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
