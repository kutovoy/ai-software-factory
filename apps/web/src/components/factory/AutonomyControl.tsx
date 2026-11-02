'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AutonomyReadWire, AutonomyState } from '@/lib/types';

/**
 * Kill switch + lights-off control (spec: autonomy policy and kill switch, ADR-018).
 *
 * Enabling autonomy is refused by the API while `benchmarkGateRequired` has no passing,
 * calibrated attestation for the running definition commit + configuration hash. The button
 * is disabled with an explanation; the only way through is an explicit override
 * {actor, reason}, confirmed in a dialog. Pausing always succeeds and forces every gate
 * back to `human`.
 */
export function AutonomyControl({
  factoryId,
  benchmarkGateRequired,
  benchmarkAttestationSatisfied,
  benchmarkAttestationCode,
  fullyAutonomous,
  mergePolicy,
  initialEvent,
  initialState,
}: {
  factoryId: string;
  benchmarkGateRequired: boolean;
  benchmarkAttestationSatisfied: boolean;
  benchmarkAttestationCode: 'benchmark_attestation_missing' | null;
  fullyAutonomous: boolean;
  mergePolicy: string;
  initialEvent: AutonomyReadWire['lastEvent'];
  initialState: AutonomyReadWire | null;
}) {
  const router = useRouter();
  const [actor, setActor] = useState('local-user');
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState<{ actor: string; reason: string } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [overrideActor, setOverrideActor] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [busy, setBusy] = useState<'enable' | 'pause' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AutonomyState | null>(null);

  const enableBlocked =
    benchmarkGateRequired && !benchmarkAttestationSatisfied && override === null;

  const submit = async (enabled: boolean): Promise<void> => {
    setError(null);
    if (!actor.trim() || !reason.trim()) {
      setError('actor and reason are required for every autonomy change');
      return;
    }
    setBusy(enabled ? 'enable' : 'pause');
    try {
      const response = await fetch(
        `/api/v1/factories/${encodeURIComponent(factoryId)}/autonomy`,
        {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled,
          actor: actor.trim(),
          reason: reason.trim(),
          ...(enabled && override ? { override } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
        autonomy?: AutonomyState;
      };
      if (!response.ok) {
        throw new Error(body.message ?? body.code ?? `autonomy change failed (${response.status})`);
      }
      setResult(body.autonomy ?? null);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(null);
    }
  };

  const confirmOverride = (): void => {
    if (!overrideActor.trim() || !overrideReason.trim()) {
      setError('an override needs both an actor and a reason');
      return;
    }
    setOverride({ actor: overrideActor.trim(), reason: overrideReason.trim() });
    setError(null);
    setDialogOpen(false);
  };

  return (
    <div data-testid="autonomy-panel" data-factory={factoryId} className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <span className="font-semibold text-slate-800">Declaration:</span>
        <span className="font-mono">{fullyAutonomous ? 'all stages agent-gated' : 'human gates present'}</span>
        <span className="text-slate-400">·</span>
        <span className="font-mono">merge: {mergePolicy}</span>
        <span className="text-slate-400">·</span>
        <span className="font-mono">
          benchmark gate{' '}
          {benchmarkGateRequired
            ? benchmarkAttestationSatisfied
              ? 'satisfied by attestation'
              : 'required (attestation missing)'
            : 'not required'}
        </span>
      </div>

      {benchmarkGateRequired && !benchmarkAttestationSatisfied ? (
        <div
          data-testid="autonomy-benchmark-gate-note"
          role="note"
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          <p className="font-semibold">Enabling autonomy needs a benchmark attestation.</p>
          <p className="mt-1">
            This factory is fully autonomous by declaration, so the loop requires a passing,
            calibrated benchmark attestation that matches the current definition commit + configuration
            hash. The API refuses with <span className="font-mono">benchmark_attestation_missing</span>{' '}
            unless an explicit override <span className="font-mono">{'{actor, reason}'}</span> is recorded.
            Run the benchmark suite to produce one.
          </p>
        </div>
      ) : benchmarkGateRequired ? (
        <div
          data-testid="autonomy-attestation-ok"
          role="note"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900"
        >
          <p className="font-semibold">Benchmark attestation matches this version.</p>
          <p className="mt-1">
            A passing, calibrated benchmark covers the current definition commit + configuration hash,
            so enabling autonomy is allowed without an override.
          </p>
        </div>
      ) : null}

      {initialState ? (
        <div
          data-testid="autonomy-read-state"
          data-enabled={initialState.enabled ? 'true' : 'false'}
          data-paused={initialState.paused ? 'true' : 'false'}
          data-updated-at={initialState.updatedAt ?? ''}
          className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700"
        >
          <p>
            <span className="font-semibold">Read model:</span>{' '}
            <span className="font-mono">
              {initialState.paused ? 'paused' : initialState.enabled ? 'enabled' : 'disabled'}
            </span>
            {initialState.everEnabled
              ? ` · last change by ${initialState.actor ?? 'unknown'} at ${initialState.updatedAt ?? 'an unrecorded time'}`
              : ' · autonomy was never enabled for this factory (no timestamp is invented)'}
          </p>
          <p data-testid="autonomy-read-reason" className="mt-1 text-slate-600">
            {initialState.reason ?? 'no reason recorded'}
          </p>
          {initialState.overrideActor ? (
            <p className="mt-1 text-amber-900">
              benchmark override by <span className="font-mono">{initialState.overrideActor}</span> —{' '}
              {initialState.overrideReason ?? 'no reason'}
            </p>
          ) : null}
        </div>
      ) : (
        <p data-testid="autonomy-read-unavailable" className="text-xs text-slate-500">
          The autonomy read model is unavailable (<span className="font-mono">GET /autonomy</span> could
          not be read). The controls below report the state the API returns after a change.
        </p>
      )}

      {initialEvent ? (
        <p data-testid="autonomy-last-event" data-type={initialEvent.type} className="text-xs text-slate-600">
          Newest autonomy event:{' '}
          <span className="font-mono">{initialEvent.type.replace('autonomy.', '')}</span> by{' '}
          <span className="font-mono">{initialEvent.actor ?? 'unknown'}</span>
          {initialEvent.at ? ` at ${initialEvent.at}` : ' (no timestamp recorded)'} —{' '}
          {initialEvent.reason ?? 'no reason recorded'}
        </p>
      ) : (
        <p data-testid="autonomy-last-event-empty" className="text-xs text-slate-500">
          No <span className="font-mono">autonomy.*</span> event has been recorded yet, so there is no
          evidence beyond the declared policy above.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-600">
          Actor
          <input
            data-testid="autonomy-actor"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            className="mt-1 block w-36 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="min-w-[16rem] flex-1 text-xs text-slate-600">
          Reason
          <input
            data-testid="autonomy-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is autonomy changing?"
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="button"
          data-testid="autonomy-pause"
          disabled={busy !== null}
          onClick={() => void submit(false)}
          className="rounded-md border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
        >
          {busy === 'pause' ? 'Pausing…' : 'Pause autonomy (kill switch)'}
        </button>
        <button
          type="button"
          data-testid="autonomy-enable"
          disabled={busy !== null || enableBlocked}
          aria-describedby={enableBlocked ? 'autonomy-block-reason' : undefined}
          onClick={() => void submit(true)}
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === 'enable' ? 'Enabling…' : 'Enable autonomy'}
        </button>
        {enableBlocked ? (
          <span id="autonomy-block-reason" data-testid="autonomy-enable-blocked" className="text-xs text-amber-800">
            disabled — benchmark attestation missing. Provide an override to proceed.
          </span>
        ) : null}
        {benchmarkGateRequired && !benchmarkAttestationSatisfied ? (
          <button
            type="button"
            data-testid="autonomy-override-open"
            onClick={() => setDialogOpen(true)}
            className="rounded-md border border-amber-300 px-3 py-2 text-xs font-medium text-amber-900 hover:bg-amber-50"
          >
            {override ? 'Override supplied' : 'Provide override…'}
          </button>
        ) : null}
      </div>

      {dialogOpen ? (
        <div
          data-testid="autonomy-override-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Autonomy override"
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
        >
          <p className="text-sm font-semibold text-amber-900">Override the benchmark gate (confirm)</p>
          <p className="mt-1 text-xs text-amber-800">
            This records who accepts the risk of unattended merges without a benchmark
            non-regression attestation. It is an audit record, not a benchmark result.
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className="text-xs text-amber-900">
              Override actor
              <input
                data-testid="autonomy-override-actor"
                value={overrideActor}
                onChange={(event) => setOverrideActor(event.target.value)}
                className="mt-1 block w-36 rounded-md border border-amber-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="min-w-[16rem] flex-1 text-xs text-amber-900">
              Override reason
              <input
                data-testid="autonomy-override-reason"
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                className="mt-1 block w-full rounded-md border border-amber-300 px-2 py-1.5 text-sm"
              />
            </label>
            <button
              type="button"
              data-testid="autonomy-override-confirm"
              onClick={confirmOverride}
              className="rounded-md bg-amber-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-800"
            >
              Confirm override
            </button>
            <button
              type="button"
              data-testid="autonomy-override-cancel"
              onClick={() => setDialogOpen(false)}
              className="text-xs text-amber-900 underline decoration-amber-300 underline-offset-2"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {override ? (
        <p data-testid="autonomy-override-recorded" className="text-xs text-amber-900">
          Override: <span className="font-mono">{override.actor}</span> — {override.reason}
        </p>
      ) : null}

      {error ? (
        <p data-testid="autonomy-error" role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}

      {result ? (
        <div data-testid="autonomy-result" className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">State reported by the API:</span>
            <span
              data-testid="autonomy-state"
              data-enabled={result.enabled ? 'true' : 'false'}
              data-paused={result.paused ? 'true' : 'false'}
              data-benchmark-required={result.benchmarkGateRequired ? 'true' : 'false'}
              data-benchmark-satisfied={result.benchmarkGateSatisfied ? 'true' : 'false'}
              className="font-mono"
            >
              {result.paused ? 'paused' : result.enabled ? 'enabled' : 'disabled'}
            </span>
            <span className="font-mono">signaled {result.signaled} work item(s)</span>
          </p>
          <p className="mt-1">
            actor <span className="font-mono">{result.actor ?? '—'}</span> — {result.reason ?? 'no reason'}
          </p>
          {result.overrideActor ? (
            <p className="mt-1">
              override <span className="font-mono">{result.overrideActor}</span> —{' '}
              {result.overrideReason ?? 'no reason'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
