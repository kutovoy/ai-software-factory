import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { CanaryActions } from '@/components/improvement/CanaryActions';
import { CanaryCountdown } from '@/components/improvement/CanaryCountdown';
import { CanaryPruneButton } from '@/components/improvement/CanaryPruneButton';
import { CanarySeriesChart } from '@/components/improvement/CanarySeriesChart';
import {
  canaryStatusLabel,
  canaryStatusTone,
  formatDelta,
  formatRate,
} from '@/lib/improvement';
import type { CanaryOverviewWire, CanaryRolloutViewWire } from '@/lib/types';

/**
 * Canary panel (Phase 5b, ADR-021): candidate vs stable, traffic split, observation-window
 * countdown, score comparison, promote/rollback and the audit history.
 *
 * Everything is a projection of the read model; when a rollout is `pending` the candidate
 * is still being published, and the panel says so instead of pretending routing started.
 */
export function CanaryPanel({
  factory,
  overview,
}: {
  factory: string;
  overview: CanaryOverviewWire | null;
}) {
  if (!overview) {
    return (
      <EmptyState
        testId="canary-unavailable"
        title="Canary projection unavailable"
        description="The API could not project this factory's canary state. Check the definition and the API."
      />
    );
  }

  const active = overview.active;
  const history = overview.history.filter((entry) => entry.rollout.id !== active?.rollout.id);

  return (
    <div data-testid="canary-panel" data-factory={factory} className="space-y-4">
      {active ? (
        <RolloutView view={active} active />
      ) : (
        <div
          data-testid="canary-empty"
          className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600"
        >
          <p className="font-semibold text-slate-800">No active canary rollout.</p>
          <p className="mt-1">
            {overview.authority === 'canary'
              ? `Configured: ${overview.resolved.canaryPercent ?? 'unset'}% of new work, rollback above ${overview.resolved.rollbackThreshold ?? 'unset'} over a ${overview.resolved.observationWindowHours}h window. Accept and apply a proposal to publish a candidate version.`
              : `Authority is ${overview.authority}; a canary rollout requires authority "canary".`}
          </p>
        </div>
      )}

      <CanaryPruneButton factory={factory} />

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Rollout history
        </h4>
        {history.length === 0 ? (
          <p data-testid="canary-history-empty" className="mt-1 text-xs text-slate-500">
            No finished rollout yet. Promotion and rollback keep the previous version
            addressable.
          </p>
        ) : (
          <ul data-testid="canary-history" className="mt-2 space-y-2">
            {history.map((entry) => (
              <li
                key={entry.rollout.id}
                data-testid="canary-history-row"
                data-status={entry.rollout.status}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-slate-800">
                    {entry.rollout.id}
                  </span>
                  <Badge tone={canaryStatusTone(entry.rollout.status)} testId="canary-history-status">
                    {canaryStatusLabel(entry.rollout.status)}
                  </Badge>
                </div>
                <p className="mt-1 font-mono text-[11px] text-slate-600">
                  {entry.rollout.candidateVersion} ← {entry.rollout.stableVersion} ·{' '}
                  {entry.split.canaryPercent}% / {entry.split.stablePercent}%
                </p>
                <p data-testid="canary-history-reason" className="mt-1">
                  {entry.rollout.reason ?? 'no reason recorded'}
                </p>
                {entry.rollout.prUrl ? (
                  <a
                    data-testid="canary-history-pr"
                    href={entry.rollout.prUrl}
                    className="underline decoration-slate-300 underline-offset-2"
                  >
                    {entry.rollout.prUrl}
                  </a>
                ) : null}
                <ul className="mt-1 flex flex-wrap gap-2">
                  {entry.events.map((event) => (
                    <li
                      key={`${entry.rollout.id}-${event.type}-${event.createdAt ?? ''}`}
                      data-testid="canary-history-event"
                      data-type={event.type}
                      className="font-mono text-[10px] text-slate-500"
                    >
                      {event.type}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RolloutView({ view, active }: { view: CanaryRolloutViewWire; active: boolean }) {
  const { rollout, split, window, metrics, series } = view;
  return (
    <div
      data-testid="canary-active"
      data-rollout-id={rollout.id}
      data-status={rollout.status}
      className="space-y-3 rounded-lg border border-sky-200 bg-sky-50/60 px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">
            Canary rollout <span className="font-mono text-xs text-slate-600">{rollout.id}</span>
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            <span data-testid="canary-candidate-version" className="font-mono">
              {rollout.candidateVersion}
            </span>{' '}
            vs stable{' '}
            <span data-testid="canary-stable-version" className="font-mono">
              {rollout.stableVersion}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={canaryStatusTone(rollout.status)} testId="canary-status">
            {canaryStatusLabel(rollout.status)}
          </Badge>
          <Badge tone={metrics?.regressionExceeded ? 'danger' : 'success'} testId="canary-regression">
            {metrics?.regressionExceeded
              ? `regression > ${rollout.rollbackThreshold}`
              : 'no regression'}
          </Badge>
        </div>
      </div>

      <div className="grid gap-2 text-xs text-slate-700 md:grid-cols-3">
        <div data-testid="canary-split" data-canary-percent={split.canaryPercent} data-stable-percent={split.stablePercent}>
          <p className="font-semibold text-slate-800">Traffic split</p>
          <p className="font-mono">
            {split.canaryPercent}% candidate · {split.stablePercent}% stable
          </p>
          <p data-testid="canary-split-counts" className="font-mono text-[11px] text-slate-600">
            {split.candidateItems} candidate · {split.stableItems} stable work item(s)
          </p>
        </div>
        <div data-testid="canary-window">
          <p className="font-semibold text-slate-800">Observation window</p>
          <p>
            <CanaryCountdown
              endsAt={window.endsAt}
              initialRemainingMs={window.remainingMs}
              active={active && rollout.status === 'active'}
            />{' '}
            of {window.observationWindowHours}h
          </p>
          <p className="font-mono text-[11px] text-slate-600">
            started {rollout.startedAt ?? '—'}
          </p>
        </div>
        <div data-testid="canary-threshold">
          <p className="font-semibold text-slate-800">Rollback threshold</p>
          <p className="font-mono">{rollout.rollbackThreshold} (pass-rate / incident regression)</p>
          <p className="font-mono text-[11px] text-slate-600">
            {metrics?.detail ?? 'no metrics yet'}
          </p>
        </div>
      </div>

      <div
        data-testid="canary-deployment"
        data-status={rollout.deploymentStatus ?? 'none'}
        className="rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
      >
        <p className="font-semibold text-slate-800">Promotion / deployment</p>
        <p className="mt-0.5">
          {rollout.deploymentStatus === 'deployed'
            ? `the deploy hook ran successfully${rollout.deployHook ? ` (${rollout.deployHook})` : ''}`
            : rollout.deploymentStatus === 'promoted_pending_deploy'
              ? `promotion merged, but the deploy hook failed: ${rollout.deployError ?? 'no error recorded'}`
              : rollout.deploymentStatus === 'promotion_pending_deploy'
                ? 'promotion merged; no deployHook is declared, so the local checkout was NOT updated'
                : 'not promoted yet'}
        </p>
        {rollout.deployedAt ? (
          <p className="font-mono text-[11px] text-slate-500">deployed at {rollout.deployedAt}</p>
        ) : null}
      </div>

      <div data-testid="canary-series-section">
        <p className="text-xs font-semibold text-slate-800">Hourly series</p>
        <CanarySeriesChart series={series} />
      </div>

      <div data-testid="canary-metrics">
        <p className="text-xs font-semibold text-slate-800">Score comparison</p>
        <table className="mt-1 w-full text-left text-xs text-slate-700">
          <thead className="text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-0.5">Version</th>
              <th>Items</th>
              <th>Scores</th>
              <th>Pass rate</th>
              <th>Errors</th>
              <th>Runs</th>
              <th>Failed runs</th>
            </tr>
          </thead>
          <tbody>
            {metrics
              ? ([
                  ['stable', metrics.stable],
                  ['candidate', metrics.candidate],
                ] as const).map(([version, stats]) => (
                  <tr key={version} data-testid="canary-metric-row" data-version={version}>
                    <td className="py-0.5 font-mono">{version}</td>
                    <td className="font-mono">{stats.workItems}</td>
                    <td className="font-mono" data-testid="canary-scores">
                      {stats.scores}
                    </td>
                    <td className="font-mono" data-testid="canary-pass-rate">
                      {formatRate(stats.passRate)}
                    </td>
                    <td className="font-mono" data-testid="canary-errors">
                      {stats.errors}
                    </td>
                    <td className="font-mono">{stats.runs}</td>
                    <td className="font-mono" data-testid="canary-failed-runs">
                      {stats.failedRuns}
                    </td>
                  </tr>
                ))
              : null}
          </tbody>
        </table>
        {metrics ? (
          <p className="mt-1 text-[11px] text-slate-600">
            pass-rate delta{' '}
            <span data-testid="canary-pass-delta" className="font-mono">
              {formatDelta(metrics.passRateDelta)}
            </span>
            {' · '}failure-rate delta{' '}
            <span data-testid="canary-failure-delta" className="font-mono">
              {formatDelta(metrics.failureRateDelta)}
            </span>
            {metrics.insufficientData ? ' · no candidate evidence yet' : ''}
          </p>
        ) : (
          <p data-testid="canary-metrics-empty" className="mt-1 text-xs text-slate-500">
            Metrics are unavailable until the candidate has published and scored runs.
          </p>
        )}
      </div>

      {rollout.prUrl ? (
        <p className="text-xs text-slate-700">
          Candidate PR:{' '}
          <a
            data-testid="canary-pr"
            href={rollout.prUrl}
            className="underline decoration-slate-300 underline-offset-2"
          >
            #{rollout.prNumber}
          </a>
        </p>
      ) : null}

      <ul className="flex flex-wrap gap-2">
        {view.events.map((event) => (
          <li
            key={`${event.type}-${event.createdAt ?? ''}`}
            data-testid="canary-event"
            data-type={event.type}
            className="font-mono text-[10px] text-slate-500"
          >
            {event.type}
          </li>
        ))}
      </ul>

      <CanaryActions
        factory={rollout.factory}
        rolloutId={rollout.id}
        active={active && rollout.status === 'active'}
      />
    </div>
  );
}
