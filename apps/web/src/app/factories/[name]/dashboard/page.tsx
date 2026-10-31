import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { safeGet } from '@/lib/api';
import { formatCost, formatTokens, shortCommit } from '@/lib/format';
import type {
  FactoryDetail,
  FactoryMetricsResponse,
  MetricCardWire,
  RunSummary,
  StageCostWire,
} from '@/lib/types';
import { factoryHeading } from '@/lib/factory';

export const dynamic = 'force-dynamic';

const STATUS_ORDER = ['ok', 'error', 'cancelled', 'running', 'pending'] as const;
const WINDOWS = ['7d', '30d', '90d'] as const;

function formatMetricValue(metric: MetricCardWire): string {
  if (metric.value === null) return '—';
  if (metric.unit === 'USD/PR') return formatCost(metric.value);
  if (metric.unit === '%') return `${metric.value}%`;
  if (metric.unit === 'hours') return `${metric.value} h`;
  return `${metric.value}`;
}

function MetricCard({ metric }: { metric: MetricCardWire }) {
  return (
    <Card testId="metric-card" className="h-full">
      <CardHeader title={metric.label} hint={metric.unit} />
      <CardBody className="space-y-1">
        <p
          data-testid="metric-value"
          data-metric={metric.key}
          data-null={metric.value === null ? 'true' : 'false'}
          className="text-2xl font-semibold text-slate-900"
        >
          {formatMetricValue(metric)}
        </p>
        {metric.value === null ? (
          <p data-testid="metric-reason" className="text-xs text-amber-700">
            {metric.reason ?? 'no data in this window'}
          </p>
        ) : (
          <p data-testid="metric-samples" className="text-xs text-slate-500">
            {metric.sampleSize} sample(s)
          </p>
        )}
        <p data-testid="metric-definition" className="text-[11px] leading-snug text-slate-500">
          {metric.definition}
        </p>
      </CardBody>
    </Card>
  );
}

function CostByStage({ metrics }: { metrics: FactoryMetricsResponse }) {
  const rows: StageCostWire[] = metrics.costByStage;
  const unattributed = metrics.unattributedCost;
  if (rows.length === 0 && unattributed.runCount === 0) {
    return (
      <EmptyState
        testId="metrics-cost-empty"
        title="No stage runs in this window"
        description="Cost attribution appears once stage runs start."
      />
    );
  }
  return (
    <table data-testid="metrics-cost-by-stage" className="min-w-full divide-y divide-slate-200 text-sm">
      <thead className="bg-slate-50">
        <tr>
          <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Stage</th>
          <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Cost</th>
          <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Runs</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr key={row.stage} data-testid="cost-stage-row" data-stage={row.stage}>
            <td className="px-4 py-2 font-mono text-xs text-slate-800">{row.stage}</td>
            <td className="px-4 py-2 font-mono text-xs text-slate-800" data-testid="cost-stage-value">
              {formatCost(row.costUsd)}
            </td>
            <td className="px-4 py-2 text-xs text-slate-600">{row.runCount}</td>
          </tr>
        ))}
        <tr data-testid="cost-unattributed-row">
          <td className="px-4 py-2 font-mono text-xs text-slate-500">unattributed</td>
          <td className="px-4 py-2 font-mono text-xs text-slate-700" data-testid="cost-unattributed-value">
            {formatCost(unattributed.costUsd)}
          </td>
          <td className="px-4 py-2 text-xs text-slate-600">{unattributed.runCount}</td>
        </tr>
      </tbody>
    </table>
  );
}

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ window?: string }>;
}) {
  const { name } = await params;
  const { window } = await searchParams;
  const factoryName = decodeURIComponent(name);
  const encoded = encodeURIComponent(factoryName);
  const windowLabel = WINDOWS.includes((window ?? '30d') as (typeof WINDOWS)[number])
    ? (window as string)
    : '30d';

  const [detail, runs, metrics] = await Promise.all([
    safeGet<{ factory: FactoryDetail } | null>(`/factories/${encoded}`, null),
    safeGet<{ runs: RunSummary[] }>(`/runs?factory=${encoded}&limit=100`, { runs: [] }),
    safeGet<FactoryMetricsResponse | null>(
      `/factories/${encoded}/metrics?window=${encodeURIComponent(windowLabel)}`,
      null,
    ),
  ]);

  const rows = runs.runs;
  const counts: Record<string, number> = {};
  for (const run of rows) counts[run.status] = (counts[run.status] ?? 0) + 1;

  const costTotal = rows.reduce((total, run) => total + (run.costUsd ?? 0), 0);
  const inputTokens = rows.reduce((total, run) => total + (run.inputTokens ?? 0), 0);
  const outputTokens = rows.reduce((total, run) => total + (run.outputTokens ?? 0), 0);
  const factory = detail?.factory;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {factoryHeading(factory?.alias, factoryName, 'Dashboard')}
          </h1>
          <p className="text-sm text-slate-500">
            Read-only projection of <span className="font-mono">factories/{factoryName}</span>.
            {factory?.version ? (
              <>
                {' '}
                Pinned at{' '}
                <span className="font-mono" data-testid="dashboard-version">
                  {shortCommit(factory.version.commit)}
                  {factory.version.tag ? ` (${factory.version.tag})` : ''}
                </span>
                .
              </>
            ) : null}
          </p>
        </div>
        {factory ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={factory.fullyAutonomous ? 'warning' : 'success'} testId="dashboard-autonomy">
              {factory.fullyAutonomous ? 'lights off' : 'lights on'}
            </Badge>
            <Badge tone="neutral">{factory.resourceCount} resources</Badge>
            <Badge tone="neutral">{factory.repoCount} repos</Badge>
          </div>
        ) : null}
      </header>

      {rows.length === 0 ? (
        <EmptyState
          testId="dashboard-empty"
          title="No runs for this factory yet"
          description="Dispatch work through New Chat; counts, status split and cost will appear here."
          action={
            <Link
              href={`/chat?factory=${encoded}`}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Open New Chat
            </Link>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          <Card testId="dashboard-counts">
            <CardHeader title="Runs" hint="Newest 100 runs for this factory." />
            <CardBody className="space-y-2">
              <p className="text-3xl font-semibold text-slate-900" data-testid="dashboard-total-runs">
                {rows.length}
              </p>
              <p className="text-xs text-slate-500">total runs</p>
            </CardBody>
          </Card>

          <Card testId="dashboard-status">
            <CardHeader title="Status split" hint="Terminal states plus in-flight runs." />
            <CardBody>
              <ul className="space-y-1 text-sm">
                {STATUS_ORDER.map((status) => {
                  const count = counts[status] ?? 0;
                  const percent = rows.length === 0 ? 0 : Math.round((count / rows.length) * 100);
                  return (
                    <li key={status} className="flex items-center gap-2" data-status={status}>
                      <span className="w-20 text-xs text-slate-600">{status}</span>
                      <span className="h-2 flex-1 rounded bg-slate-100">
                        <span
                          className="block h-2 rounded bg-slate-700"
                          style={{ width: `${percent}%` }}
                        />
                      </span>
                      <span className="w-10 text-right text-xs font-medium text-slate-700" data-testid={`dashboard-status-${status}`}>
                        {count}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </CardBody>
          </Card>

          <Card testId="dashboard-cost">
            <CardHeader title="Spend" hint="Sum over the listed runs." />
            <CardBody className="space-y-2">
              <p className="text-3xl font-semibold text-slate-900" data-testid="dashboard-cost-total">
                {formatCost(costTotal)}
              </p>
              <p className="text-xs text-slate-500" data-testid="dashboard-tokens">
                in {formatTokens(inputTokens)} · out {formatTokens(outputTokens)} tokens
              </p>
            </CardBody>
          </Card>
        </div>
      )}

      <Card testId="dashboard-metrics">
        <CardHeader
          title="Factory metrics"
          hint="Derived at read time from runs, work items, gates and forge checks (ADR-017). Null means no data, never zero."
          action={
            <div className="flex items-center gap-1" data-testid="metrics-window">
              {WINDOWS.map((candidate) => (
                <Link
                  key={candidate}
                  href={`/factories/${encoded}/dashboard?window=${candidate}`}
                  data-testid={`metrics-window-${candidate}`}
                  data-active={candidate === windowLabel ? 'true' : 'false'}
                  className={`rounded px-2 py-1 text-xs font-medium ${
                    candidate === windowLabel
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {candidate}
                </Link>
              ))}
            </div>
          }
        />
        <CardBody className="space-y-4">
          {!metrics ? (
            <EmptyState
              testId="metrics-unavailable"
              title="Metrics unavailable"
              description="The API did not return metrics. No numbers are fabricated."
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral" testId="metrics-window-label">
                  window {metrics.window.label} · {metrics.window.days.toFixed(1)} days
                </Badge>
                <Badge
                  tone={
                    metrics.benchmarkGate.required
                      ? metrics.benchmarkGate.satisfied
                        ? 'success'
                        : 'warning'
                      : 'neutral'
                  }
                  testId="metrics-benchmark-gate"
                >
                  benchmark gate{' '}
                  {metrics.benchmarkGate.required
                    ? metrics.benchmarkGate.satisfied
                      ? 'satisfied'
                      : 'blocked'
                    : 'not required'}
                </Badge>
                {metrics.benchmarkGate.reason ? (
                  <span className="text-xs text-amber-700">{metrics.benchmarkGate.reason}</span>
                ) : null}
              </div>

              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                {metrics.metrics.map((metric) => (
                  <MetricCard key={metric.key} metric={metric} />
                ))}
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-900">Cost by stage</h3>
                <p className="mb-2 text-xs text-slate-500">
                  Attributed from the stage run id convention; unattributed cost (chat/ad-hoc runs)
                  is reported separately rather than hidden.
                </p>
                <CostByStage metrics={metrics} />
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
