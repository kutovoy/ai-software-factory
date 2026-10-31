import Link from 'next/link';
import { ReadOnlyNotice } from '@/components/factory/ReadOnlyNotice';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { safeGet } from '@/lib/api';
import { formatCost, formatRelative } from '@/lib/format';
import type {
  CalibrationResultWire,
  FactoryDetail,
  ScoreAggregateWire,
  ScorersResponse,
  ScoresResponse,
} from '@/lib/types';
import { factoryHeading } from '@/lib/factory';

export const dynamic = 'force-dynamic';

function calibrationBadge(result: CalibrationResultWire | null, required: boolean) {
  if (!required) {
    return (
      <Badge tone="neutral" testId="scorer-calibration">
        not required
      </Badge>
    );
  }
  if (!result) {
    return (
      <Badge tone="warning" testId="scorer-calibration">
        uncalibrated
      </Badge>
    );
  }
  if (result.verdict === 'pass') {
    return (
      <Badge tone="success" testId="scorer-calibration">
        calibrated
      </Badge>
    );
  }
  if (result.verdict === 'insufficient_data') {
    return (
      <Badge tone="info" testId="scorer-calibration">
        insufficient data
      </Badge>
    );
  }
  return (
    <Badge tone="danger" testId="scorer-calibration">
      calibration failed
    </Badge>
  );
}

function ConfusionTable({ result }: { result: CalibrationResultWire }) {
  const humans = Object.keys(result.confusion).sort();
  const judges = [...new Set(humans.flatMap((human) => Object.keys(result.confusion[human] ?? {})))].sort();
  if (humans.length === 0) {
    return <p className="text-xs text-slate-500">No observations recorded.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table data-testid="calibration-confusion" className="min-w-full text-xs">
        <thead>
          <tr>
            <th className="px-2 py-1 text-left font-semibold text-slate-500">human \ judge</th>
            {judges.map((judge) => (
              <th key={judge} className="px-2 py-1 text-left font-mono font-medium text-slate-600">
                {judge}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {humans.map((human) => (
            <tr key={human} className="border-t border-slate-100">
              <td className="px-2 py-1 font-mono text-slate-800">{human}</td>
              {judges.map((judge) => (
                <td key={`${human}-${judge}`} className="px-2 py-1 text-slate-700">
                  {result.confusion[human]?.[judge] ?? 0}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CalibrationPanel({ scorer }: { scorer: ScorersResponse['scorers'][number] }) {
  const latest = scorer.calibration.latest;
  return (
    <Card testId="calibration-panel" className="border-slate-200">
      <CardHeader
        title={`Calibration · ${scorer.name}`}
        hint="Judge-vs-human agreement on a hand-labelled golden set for the current rubric hash."
        action={calibrationBadge(latest, scorer.calibration.required)}
      />
      <CardBody className="space-y-3">
        {!latest ? (
          <div data-testid="calibration-insufficient" className="rounded-lg border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-600">
            No calibration has been run for this rubric hash. Scores are marked{' '}
            <span className="font-mono">uncalibrated</span> and cannot satisfy the benchmark gate.
          </div>
        ) : latest.verdict === 'insufficient_data' ? (
          <div data-testid="calibration-insufficient" className="rounded-lg border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-600">
            <p className="font-semibold text-slate-800">insufficient_data</p>
            <p>
              {latest.sampleSize} example(s); the golden set is below the configured minimum size,
              so no verdict is issued.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Judge model <span className="font-mono">{latest.judgeModel}</span> · rubric{' '}
              <span className="font-mono">{latest.rubricHash.slice(0, 12)}…</span>
            </p>
          </div>
        ) : (
          <>
            <dl className="grid gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-slate-500">Verdict</dt>
                <dd data-testid="calibration-verdict">
                  <Badge tone={latest.verdict === 'pass' ? 'success' : 'danger'}>{latest.verdict}</Badge>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Exact agreement</dt>
                <dd data-testid="calibration-agreement" className="font-mono text-slate-900">
                  {latest.agreementExact === null ? '—' : latest.agreementExact.toFixed(3)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Within tolerance</dt>
                <dd className="font-mono text-slate-900">
                  {latest.agreementWithinTolerance === null
                    ? '—'
                    : latest.agreementWithinTolerance.toFixed(3)}{' '}
                  <span className="text-xs text-slate-400">(±{latest.tolerance})</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Samples / threshold</dt>
                <dd className="font-mono text-slate-900">
                  {latest.sampleSize} / {latest.threshold}
                </dd>
              </div>
            </dl>
            <ConfusionTable result={latest} />
            <p className="text-xs text-slate-500">
              Judge <span className="font-mono">{latest.judgeModel}</span>
              {latest.judgeModelVersion ? ` (${latest.judgeModelVersion})` : ''} · rubric{' '}
              <span className="font-mono">{latest.rubricHash.slice(0, 12)}…</span> ·{' '}
              {formatRelative(latest.createdAt)}
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

export default async function ScorersPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const factory = decodeURIComponent(name);
  const encoded = encodeURIComponent(factory);

  const [detail, registry, scores] = await Promise.all([
    safeGet<{ factory: FactoryDetail } | null>(`/factories/${encoded}`, null),
    safeGet<ScorersResponse | null>(`/factories/${encoded}/scorers`, null),
    safeGet<ScoresResponse>(`/scores?factory=${encoded}&limit=1`, { scores: [], aggregate: [] }),
  ]);

  const scorers = registry?.scorers ?? [];
  const aggregates: ScoreAggregateWire[] = scores.aggregate;
  const judgeScorers = scorers.filter((scorer) => scorer.class === 'judge');

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {factoryHeading(detail?.factory.alias, factory, 'Scorers')}
          </h1>
          <p className="text-sm text-slate-500">
            Real scores over real runs: deterministic checks are free and always run; judges are
            sampled, budget-capped and calibrated against a human-labelled golden set.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {registry ? (
            <>
              <Badge tone="neutral" testId="scorers-count">
                {scorers.length} scorers
              </Badge>
              <Badge tone="info" testId="scorers-budget">
                judge budget {registry.budget.usedToday}/{registry.budget.maxPerDay} today
              </Badge>
              <Badge
                tone={
                  registry.benchmarkGate.required
                    ? registry.benchmarkGate.satisfied
                      ? 'success'
                      : 'warning'
                    : 'neutral'
                }
                testId="scorers-benchmark-gate"
              >
                benchmark gate{' '}
                {registry.benchmarkGate.required
                  ? registry.benchmarkGate.satisfied
                    ? 'satisfied'
                    : 'blocked'
                  : 'not required'}
              </Badge>
            </>
          ) : null}
        </div>
      </header>

      <ReadOnlyNotice path={`factories/${factory}`} testId="scorers-readonly-banner" />

      {!registry ? (
        <EmptyState
          testId="scorers-unavailable"
          title="Scoring registry unavailable"
          description="The API did not return the scorer registry. Definitions stay in git; nothing is fabricated here."
        />
      ) : scorers.length === 0 ? (
        <EmptyState
          testId="scorers-empty"
          title="No scorers declared"
          description="The definition has no resources under scorers/, so runs cannot be scored yet."
        />
      ) : (
        <>
          {registry.benchmarkGate.reason ? (
            <p data-testid="scorers-benchmark-reason" className="text-sm text-amber-700">
              {registry.benchmarkGate.reason}
            </p>
          ) : null}

          <Card testId="scorers-registry">
            <CardHeader
              title="Registry"
              hint="Loaded from the git-backed definition; the rubric hash changes when the body or labels change."
            />
            <div className="overflow-x-auto">
              <table data-testid="scorers-table" className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    {['Scorer', 'Class', 'Labels', 'Passing', 'Sampling', 'Judge model', 'Calibration', 'Samples', 'Pass rate', 'Cost'].map((header) => (
                      <th key={header} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {scorers.map((scorer) => {
                    const aggregate = aggregates.find((candidate) => candidate.scorer === scorer.name);
                    return (
                      <tr key={scorer.name} data-testid="scorer-row" data-scorer={scorer.name}>
                        <td className="px-4 py-2 align-top">
                          <p className="font-medium text-slate-900">{scorer.name}</p>
                          <p className="font-mono text-[11px] text-slate-500">{scorer.path}</p>
                          <p className="font-mono text-[11px] text-slate-400" data-testid="scorer-rubric-hash">
                            {scorer.rubricHash.slice(0, 12)}…
                          </p>
                        </td>
                        <td className="px-4 py-2 align-top">
                          <Badge tone={scorer.class === 'deterministic' ? 'info' : 'neutral'} testId="scorer-class">
                            {scorer.class}
                          </Badge>
                        </td>
                        <td className="px-4 py-2 align-top">
                          <ul data-testid="scorer-labels" className="space-y-0.5">
                            {scorer.labels.map((label) => (
                              <li key={label.value} className="font-mono text-xs text-slate-700">
                                {label.value} <span className="text-slate-400">({label.score})</span>
                              </li>
                            ))}
                          </ul>
                        </td>
                        <td className="px-4 py-2 align-top font-mono text-xs" data-testid="scorer-passing-score">
                          {scorer.passingScore}
                        </td>
                        <td className="px-4 py-2 align-top font-mono text-xs" data-testid="scorer-sampling-rate">
                          {scorer.samplingRate}%
                        </td>
                        <td className="px-4 py-2 align-top font-mono text-xs text-slate-700" data-testid="scorer-judge-model">
                          {scorer.judgeModel}
                        </td>
                        <td className="px-4 py-2 align-top">
                          {calibrationBadge(scorer.calibration.latest, scorer.calibration.required)}
                        </td>
                        <td className="px-4 py-2 align-top font-mono text-xs" data-testid="scorer-samples">
                          {aggregate ? aggregate.sampleCount : 0}
                        </td>
                        <td className="px-4 py-2 align-top font-mono text-xs" data-testid="scorer-pass-rate">
                          {aggregate?.passRate === null || aggregate?.passRate === undefined
                            ? '—'
                            : `${(aggregate.passRate * 100).toFixed(0)}%`}
                        </td>
                        <td className="px-4 py-2 align-top font-mono text-xs" data-testid="scorer-cost">
                          {formatCost(aggregate?.costUsd ?? 0)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {judgeScorers.length > 0 ? (
            <div className="space-y-4">
              {judgeScorers.map((scorer) => (
                <CalibrationPanel key={scorer.name} scorer={scorer} />
              ))}
            </div>
          ) : null}

          <p className="text-xs text-slate-500">
            Recent scores:{' '}
            <Link
              href={`/runs?factory=${encoded}`}
              className="underline decoration-slate-300 underline-offset-2"
            >
              open a run
            </Link>{' '}
            to see scores attached to it.
          </p>
        </>
      )}
    </div>
  );
}
