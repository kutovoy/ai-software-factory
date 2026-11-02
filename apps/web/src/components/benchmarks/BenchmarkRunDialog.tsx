'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  BenchmarkEstimateWire,
  BenchmarkSuiteEntryWire,
  StartedBenchmarkWire,
} from '@/lib/types';

/**
 * Benchmark run dialog (spec `benchmarks`): choose configurations and tasks, see the cost
 * estimate, confirm above the threshold, set a hard cap, then start. The estimate is the
 * only number the dialog shows before a run; nothing is fabricated.
 */
export function BenchmarkRunDialog({
  factoryId,
  suites,
  defaultMaxCostUsd,
}: {
  factoryId: string;
  suites: BenchmarkSuiteEntryWire[];
  defaultMaxCostUsd: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [suiteName, setSuiteName] = useState(suites[0]?.name ?? '');
  const [configurations, setConfigurations] = useState<string[]>([]);
  const [tasks, setTasks] = useState<string[]>([]);
  const [estimate, setEstimate] = useState<BenchmarkEstimateWire | null>(null);
  const [maxCostUsd, setMaxCostUsd] = useState(String(defaultMaxCostUsd));
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<StartedBenchmarkWire | null>(null);

  const suite = suites.find((candidate) => candidate.name === suiteName) ?? null;

  const resetForSuite = useCallback((next: BenchmarkSuiteEntryWire | null) => {
    setConfigurations(next ? next.configurations.map((configuration) => configuration.name) : []);
    setTasks(next ? next.tasks.map((task) => task.slug) : []);
    setEstimate(null);
    setConfirm(false);
  }, []);

  useEffect(() => {
    if (open) resetForSuite(suite);
  }, [open, suite, resetForSuite]);

  const preview = async (): Promise<void> => {
    if (!suite) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/factories/${encodeURIComponent(factoryId)}/benchmarks/${encodeURIComponent(suite.name)}/run`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            dryRun: true,
            configurations,
            tasks,
            maxCostUsd: Number(maxCostUsd),
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as
        | BenchmarkEstimateWire
        | { message?: string; code?: string };
      if (!response.ok) {
        throw new Error(('message' in body && body.message) || 'estimate failed');
      }
      setEstimate(body as BenchmarkEstimateWire);
      setConfirm(false);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : String(previewError));
    } finally {
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    if (!suite) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/factories/${encodeURIComponent(factoryId)}/benchmarks/${encodeURIComponent(suite.name)}/run`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            configurations,
            tasks,
            confirm: confirm || Boolean(estimate && !estimate.estimate.requiresConfirmation),
            maxCostUsd: Number(maxCostUsd),
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as
        | StartedBenchmarkWire
        | { message?: string; code?: string; details?: unknown };
      if (!response.ok) {
        throw new Error(('message' in body && body.message) || 'benchmark did not start');
      }
      setStarted(body as StartedBenchmarkWire);
      router.refresh();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setBusy(false);
    }
  };

  if (suites.length === 0) return null;

  return (
    <div data-testid="benchmark-run-control">
      <button
        type="button"
        data-testid="benchmark-run-open"
        onClick={() => {
          setStarted(null);
          setOpen(true);
        }}
        className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
      >
        Run benchmark…
      </button>

      {open ? (
        <div
          data-testid="benchmark-run-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Run a benchmark"
          className="mt-3 rounded-xl border border-slate-300 bg-white px-4 py-4 shadow-sm"
        >
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="text-xs text-slate-600">
              Suite
              <select
                data-testid="benchmark-run-suite"
                value={suiteName}
                onChange={(event) => setSuiteName(event.target.value)}
                className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {suites.map((candidate) => (
                  <option key={candidate.name} value={candidate.name}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              data-testid="benchmark-run-close"
              onClick={() => setOpen(false)}
              className="text-xs text-slate-500 underline decoration-slate-300 underline-offset-2"
            >
              Close
            </button>
          </div>

          {suite ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <fieldset data-testid="benchmark-run-configurations">
                <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Configurations
                </legend>
                <div className="mt-1 space-y-1">
                  {suite.configurations.map((configuration) => (
                    <label key={configuration.name} className="flex items-center gap-2 text-xs text-slate-700">
                      <input
                        type="checkbox"
                        data-testid="benchmark-run-configuration"
                        data-configuration={configuration.name}
                        checked={configurations.includes(configuration.name)}
                        onChange={(event) =>
                          setConfigurations((current) =>
                            event.target.checked
                              ? [...current, configuration.name]
                              : current.filter((name) => name !== configuration.name),
                          )
                        }
                      />
                      <span className="font-mono">{configuration.name}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset data-testid="benchmark-run-tasks">
                <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Tasks
                </legend>
                <div className="mt-1 space-y-1">
                  {suite.tasks.map((task) => (
                    <label key={task.slug} className="flex items-center gap-2 text-xs text-slate-700">
                      <input
                        type="checkbox"
                        data-testid="benchmark-run-task"
                        data-task={task.slug}
                        checked={tasks.includes(task.slug)}
                        onChange={(event) =>
                          setTasks((current) =>
                            event.target.checked
                              ? [...current, task.slug]
                              : current.filter((slug) => slug !== task.slug),
                          )
                        }
                      />
                      <span className="font-mono">{task.slug}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <button
              type="button"
              data-testid="benchmark-run-estimate"
              disabled={busy || configurations.length === 0 || tasks.length === 0}
              onClick={() => void preview()}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {busy ? 'Estimating…' : 'Estimate'}
            </button>
            <label className="text-xs text-slate-600">
              Hard cap (USD)
              <input
                data-testid="benchmark-run-cap"
                value={maxCostUsd}
                onChange={(event) => setMaxCostUsd(event.target.value)}
                inputMode="decimal"
                className="mt-1 block w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <button
              type="button"
              data-testid="benchmark-run-start"
              disabled={
                busy ||
                configurations.length === 0 ||
                tasks.length === 0 ||
                (estimate?.estimate.requiresConfirmation === true && !confirm)
              }
              onClick={() => void start()}
              className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Starting…' : 'Start benchmark'}
            </button>
          </div>

          {estimate ? (
            <div data-testid="benchmark-run-estimate-result" className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
              <p>
                <span className="font-semibold">{estimate.trials}</span> trials × median run cost{' '}
                <span className="font-mono">${estimate.estimate.medianRunCostUsd.toFixed(2)}</span> ={' '}
                <span data-testid="benchmark-run-estimate-usd" className="font-mono font-semibold">
                  ${estimate.estimate.estimateUsd.toFixed(2)}
                </span>
              </p>
              <p className="mt-1 text-slate-500">
                Confirmation threshold ${estimate.estimate.thresholdUsd.toFixed(2)}
                {estimate.estimate.requiresConfirmation
                  ? ' — this estimate needs an explicit confirmation.'
                  : ' — below the threshold.'}
                {estimate.fullMatrix ? '' : ' Partial matrix: results are reported, but no attestation is issued.'}
              </p>
              {estimate.estimate.requiresConfirmation ? (
                <label className="mt-2 flex items-center gap-2 text-xs text-amber-900">
                  <input
                    type="checkbox"
                    data-testid="benchmark-run-confirm"
                    checked={confirm}
                    onChange={(event) => setConfirm(event.target.checked)}
                  />
                  I confirm spending up to ${estimate.estimate.estimateUsd.toFixed(2)} (hard cap $
                  {Number(maxCostUsd).toFixed(2)})
                </label>
              ) : null}
            </div>
          ) : null}

          {started ? (
            <p data-testid="benchmark-run-started" className="mt-3 text-xs text-emerald-800">
              Started <span className="font-mono">{started.benchmark.id}</span> — {started.trials} trials, cap $
              {started.benchmark.maxCostUsd.toFixed(2)}. The results appear below when the workflow finishes.
            </p>
          ) : null}

          {error ? (
            <p data-testid="benchmark-run-error" role="alert" className="mt-2 text-xs text-red-700">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
