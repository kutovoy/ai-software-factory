import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { ParetoScatter } from './ParetoScatter';
import type { BenchmarkRunDetailResponse } from '@/lib/types';

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Results matrix + Pareto scatter + recommendation + per-trial drill-down. */
export function BenchmarkResults({
  factoryId,
  detail,
}: {
  factoryId: string;
  detail: BenchmarkRunDetailResponse;
}) {
  const { benchmark, results, trials, frontier, labels, recommendation, recommendationReason } = detail;
  const labelsFor = (configuration: string): string[] =>
    (Object.entries(labels) as [string, string | null][])
      .filter(([, value]) => value === configuration)
      .map(([label]) => label);

  return (
    <div className="space-y-4" data-testid="benchmark-results">
      <Card testId="benchmark-summary-card">
        <CardHeader
          title={`${benchmark.suite} — ${benchmark.status}`}
          hint={`${benchmark.id} · definition ${benchmark.definitionCommit.slice(0, 8)} · config ${benchmark.configHash.slice(0, 8)}`}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral" testId="benchmark-status-badge">
                {benchmark.status}
              </Badge>
              <Badge tone={benchmark.passed ? 'success' : 'warning'} testId="benchmark-pass-badge">
                {benchmark.passed ? 'passed' : 'not passed'}
              </Badge>
              <Badge tone={benchmark.calibrationOk ? 'success' : 'warning'} testId="benchmark-calibration-badge">
                {benchmark.calibrationOk ? 'calibrated' : 'uncalibrated'}
              </Badge>
              {benchmark.budgetExhausted ? (
                <Badge tone="warning" testId="benchmark-budget-badge">
                  budget exhausted
                </Badge>
              ) : null}
              {benchmark.partial ? (
                <Badge tone="neutral" testId="benchmark-partial-badge">
                  partial matrix
                </Badge>
              ) : null}
            </div>
          }
        />
        <CardBody className="grid gap-3 text-xs text-slate-600 sm:grid-cols-4">
          <p>
            <span className="font-semibold text-slate-800">Pass rate:</span>{' '}
            <span data-testid="benchmark-pass-rate" className="font-mono">
              {percent(benchmark.passRate)}
            </span>
          </p>
          <p>
            <span className="font-semibold text-slate-800">Spent:</span>{' '}
            <span className="font-mono">{usd(benchmark.spentUsd)}</span> / cap{' '}
            <span className="font-mono">{usd(benchmark.maxCostUsd)}</span>
          </p>
          <p>
            <span className="font-semibold text-slate-800">Trials:</span>{' '}
            <span className="font-mono">{trials.length}</span> ({detail.aggregate.sampleSize} samples,{' '}
            {detail.aggregate.errors} errors, {detail.aggregate.skipped} skipped)
          </p>
          <p>
            <span className="font-semibold text-slate-800">Estimate:</span>{' '}
            <span className="font-mono">{benchmark.estimateUsd === null ? '—' : usd(benchmark.estimateUsd)}</span>
          </p>
          {benchmark.error ? (
            <p className="sm:col-span-4 text-red-700" data-testid="benchmark-error">
              {benchmark.error}
            </p>
          ) : null}
        </CardBody>
      </Card>

      <Card testId="benchmark-matrix-card">
        <CardHeader
          title="Results matrix"
          hint="Per configuration: pass rate, weighted score, samples, cost, errors. Only successful trials are samples."
        />
        <CardBody className="space-y-3">
          {results.length === 0 ? (
            <EmptyState
              testId="benchmark-results-empty"
              title="No aggregated results yet"
              description="The workflow has not finished aggregating trials, or every trial failed before a sample existed."
            />
          ) : (
            <Table
              testId="benchmark-results-table"
              rowTestId="benchmark-result-row"
              rows={results}
              rowKey={(row) => row.configuration}
              columns={[
                {
                  header: 'Configuration',
                  cell: (row) => (
                    <span data-testid="benchmark-result-configuration" className="font-mono text-xs">
                      {row.configuration}
                    </span>
                  ),
                },
                {
                  header: 'Pass rate',
                  cell: (row) => (
                    <span data-testid="benchmark-result-pass-rate" className="font-mono text-xs">
                      {percent(row.passRate)}
                    </span>
                  ),
                },
                {
                  header: 'Weighted score',
                  cell: (row) => (
                    <span className="font-mono text-xs">
                      {row.weightedScore === null ? '—' : row.weightedScore.toFixed(3)}
                    </span>
                  ),
                },
                {
                  header: 'Samples',
                  cell: (row) => (
                    <span className="font-mono text-xs">
                      {row.passingCount}/{row.sampleSize}
                    </span>
                  ),
                },
                {
                  header: 'Cost',
                  cell: (row) => <span className="font-mono text-xs">{usd(row.costUsd)}</span>,
                },
                {
                  header: 'Errors',
                  cell: (row) => (
                    <span className="font-mono text-xs">
                      {row.errors}
                      {row.skipped > 0 ? ` (+${row.skipped} skipped)` : ''}
                    </span>
                  ),
                },
                {
                  header: 'Labels',
                  cell: (row) => (
                    <span data-testid="benchmark-result-labels" className="flex flex-wrap gap-1">
                      {row.frontier ? <Badge tone="success">frontier</Badge> : null}
                      {labelsFor(row.configuration).map((label) => (
                        <Badge key={label} tone="info">
                          {label}
                        </Badge>
                      ))}
                      {row.uncalibrated ? <Badge tone="warning">uncalibrated</Badge> : null}
                      {row.dominatedBy ? (
                        <Badge tone="neutral">dominated by {row.dominatedBy}</Badge>
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </CardBody>
      </Card>

      <Card testId="benchmark-frontier-card">
        <CardHeader
          title="Pareto frontier"
          hint="Non-dominated configurations on pass rate versus cost (ADR-019)."
        />
        <CardBody className="space-y-3">
          <ParetoScatter results={results} frontier={frontier} />
          <div data-testid="benchmark-frontier" className="text-xs text-slate-700">
            <span className="font-semibold">Frontier:</span>{' '}
            <span className="font-mono">{frontier.length > 0 ? frontier.join(', ') : '—'}</span>
          </div>
          <div data-testid="benchmark-labels" className="flex flex-wrap gap-2 text-xs text-slate-700">
            <Badge tone="info">highest performance: {labels.highest_performance ?? '—'}</Badge>
            <Badge tone="info">most efficient: {labels.most_efficient ?? '—'}</Badge>
            <Badge tone="info">lowest cost: {labels.lowest_cost ?? '—'}</Badge>
          </div>
          <div
            data-testid="benchmark-recommendation"
            data-configuration={recommendation?.configuration ?? ''}
            className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700"
          >
            {recommendation ? (
              <>
                <span className="font-semibold">Recommendation: {recommendation.configuration}</span>{' '}
                —{' '}
                {recommendation.reason === 'dominance'
                  ? 'it dominates every other configuration on pass rate and cost.'
                  : 'it is the only configuration with samples.'}
              </>
            ) : (
              <>
                <span className="font-semibold">No single recommendation.</span>{' '}
                {recommendationReason === 'no_samples'
                  ? 'No configuration has a sample.'
                  : 'The frontier has more than one configuration; choose by the axis you care about.'}
              </>
            )}
          </div>
        </CardBody>
      </Card>

      <Card testId="benchmark-trials-card">
        <CardHeader
          title="Per-trial drill-down"
          hint="Every trial is a hermetic child run at a pinned full SHA and definition commit."
        />
        <CardBody>
          {trials.length === 0 ? (
            <EmptyState
              testId="benchmark-trials-empty"
              title="No trials recorded"
              description="The workflow has not started its trials yet."
            />
          ) : (
            <Table
              testId="benchmark-trials-table"
              rowTestId="benchmark-trial-row"
              rows={trials}
              rowKey={(row) => row.id}
              columns={[
                {
                  header: 'Configuration',
                  cell: (row) => <span className="font-mono text-xs">{row.configuration}</span>,
                },
                { header: 'Task', cell: (row) => <span className="font-mono text-xs">{row.task}</span> },
                {
                  header: 'Status',
                  cell: (row) => (
                    <Badge
                      tone={row.status === 'ok' ? 'success' : row.status === 'skipped' ? 'neutral' : 'warning'}
                      testId="benchmark-trial-status"
                    >
                      {row.status}
                      {row.errorCode ? ` · ${row.errorCode}` : ''}
                    </Badge>
                  ),
                },
                {
                  header: 'Score',
                  cell: (row) => (
                    <span className="font-mono text-xs">{row.score === null ? '—' : row.score.toFixed(3)}</span>
                  ),
                },
                {
                  header: 'Cost',
                  cell: (row) => <span className="font-mono text-xs">{usd(row.costUsd)}</span>,
                },
                {
                  header: 'Run',
                  cell: (row) =>
                    row.runId ? (
                      <Link
                        data-testid="benchmark-trial-run"
                        href={`/factories/${encodeURIComponent(factoryId)}/runs/${encodeURIComponent(row.runId)}`}
                        className="text-xs text-slate-900 underline decoration-slate-300 underline-offset-2"
                      >
                        {row.runId}
                      </Link>
                    ) : (
                      <span className="text-xs text-slate-500">—</span>
                    ),
                },
                {
                  header: 'Pinned refs',
                  cell: (row) => (
                    <span className="font-mono text-[11px] text-slate-500">
                      {row.startingRepoRefs.join(', ')}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
