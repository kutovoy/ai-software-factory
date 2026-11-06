'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Manual run GC (change `add-retention-quotas-promotion`). Applies the same retention rules
 * as the worker sweep: terminal runs older than `days` and beyond the newest `keep` are
 * removed with their rows, run directory and stored artifact blobs. `dryRun` reports the
 * plan without deleting anything. The wire shape is declared locally so `lib/types.ts`
 * (shared by the whole console) does not have to change for one control.
 */

interface RunsGcResponseWire {
  factory: string;
  dryRun: boolean;
  days: number;
  keep: number;
  scanned: number;
  /** Deleted runs, or the plan under `dryRun`. */
  removed: number;
  removedRunIds: string[];
  kept: number;
  protected: number;
  artifactsDeleted: number;
  artifactsFailed: number;
  runDirsRemoved: number;
  errors: string[];
  canaryTrees: { kept: number; removed: number; protected: number };
}

export function RunsGcButton({ factoryId }: { factoryId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [actor, setActor] = useState('local-user');
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('');
  const [keep, setKeep] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunsGcResponseWire | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    if (!actor.trim() || !reason.trim()) {
      setError('actor and reason are required to collect runs');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/factories/${encodeURIComponent(factoryId)}/runs/gc`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            actor: actor.trim(),
            reason: reason.trim(),
            ...(days.trim() === '' ? {} : { days: Number(days) }),
            ...(keep.trim() === '' ? {} : { keep: Number(keep) }),
            dryRun,
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as
        | RunsGcResponseWire
        | { message?: string; code?: string };
      if (!response.ok) {
        const failure = body as { message?: string; code?: string };
        throw new Error(failure.message ?? failure.code ?? `GC failed (${response.status})`);
      }
      setResult(body as RunsGcResponseWire);
      setOpen(false);
      if (!dryRun) router.refresh();
    } catch (gcError) {
      setError(gcError instanceof Error ? gcError.message : String(gcError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="runs-gc" className="space-y-1">
      {open ? (
        <div className="flex flex-wrap items-end gap-2 rounded border border-slate-200 bg-white px-2 py-2 text-[11px]">
          <label className="text-slate-600">
            Actor
            <input
              data-testid="runs-gc-actor"
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              className="mt-0.5 block w-28 rounded border border-slate-300 px-1.5 py-1"
            />
          </label>
          <label className="text-slate-600">
            Reason
            <input
              data-testid="runs-gc-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="mt-0.5 block w-48 rounded border border-slate-300 px-1.5 py-1"
            />
          </label>
          <label className="text-slate-600">
            Days
            <input
              data-testid="runs-gc-days"
              value={days}
              onChange={(event) => setDays(event.target.value)}
              placeholder="default"
              inputMode="numeric"
              className="mt-0.5 block w-20 rounded border border-slate-300 px-1.5 py-1"
            />
          </label>
          <label className="text-slate-600">
            Keep
            <input
              data-testid="runs-gc-keep"
              value={keep}
              onChange={(event) => setKeep(event.target.value)}
              placeholder="default"
              inputMode="numeric"
              className="mt-0.5 block w-20 rounded border border-slate-300 px-1.5 py-1"
            />
          </label>
          <label className="flex items-center gap-1 text-slate-600">
            <input
              data-testid="runs-gc-dry-run"
              type="checkbox"
              checked={dryRun}
              onChange={(event) => setDryRun(event.target.checked)}
            />
            Dry run
          </label>
          <button
            type="button"
            data-testid="runs-gc-submit"
            disabled={busy}
            onClick={() => void submit()}
            className="rounded bg-slate-900 px-2 py-1 font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'Collecting…' : dryRun ? 'Preview' : 'Collect'}
          </button>
          <button
            type="button"
            data-testid="runs-gc-dismiss"
            onClick={() => setOpen(false)}
            className="text-slate-500 underline decoration-slate-300 underline-offset-2"
          >
            Dismiss
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="runs-gc-open"
          onClick={() => setOpen(true)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-300"
        >
          Collect old runs…
        </button>
      )}

      {result ? (
        <div data-testid="runs-gc-result" className="text-[11px] text-slate-600">
          <p>
            {result.dryRun ? 'would remove' : 'removed'} {result.removed} · kept {result.kept} ·
            protected {result.protected} · scanned {result.scanned}
          </p>
          <p>
            artifacts {result.dryRun ? 'planned' : 'deleted'} {result.artifactsDeleted} · failed{' '}
            {result.artifactsFailed} · run dirs {result.runDirsRemoved} · canary trees{' '}
            {result.canaryTrees.removed}
          </p>
          {result.errors.length > 0 ? (
            <ul data-testid="runs-gc-errors" className="text-red-700">
              {result.errors.slice(0, 5).map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
              {result.errors.length > 5 ? <li>…and {result.errors.length - 5} more</li> : null}
            </ul>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p data-testid="runs-gc-error" role="alert" className="text-[11px] text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
