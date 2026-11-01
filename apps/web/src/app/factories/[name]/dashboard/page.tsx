import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { safeGet } from '@/lib/api';
import { formatCost, formatTokens, shortCommit, statusTone } from '@/lib/format';
import { TimeAgo } from '@/components/ui/TimeAgo';
import type {
  AutonomyReadWire,
  CanaryOverviewWire,
  FactoryDetail,
  FactoryMetricsResponse,
  MetricCardWire,
  RunArtifact,
  RunDetail,
  RunSummary,
  StageCostWire,
  WorkItemSummary,
} from '@/lib/types';
import { factoryHeading } from '@/lib/factory';

export const dynamic = 'force-dynamic';

const STATUS_ORDER = ['ok', 'error', 'cancelled', 'running', 'pending'] as const;
const WINDOWS = ['7d', '30d', '90d'] as const;
/** Work items shown in the "recent work" list. */
const RECENT_ITEMS = 8;
/** Runs shown in the "recent runs" list. */
const RECENT_RUNS = 8;
/** How many of the newest runs are inspected for artifacts (patch, logs). */
const ARTIFACT_SCAN = 3;

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

/** Newest timestamp across the runs and items we already fetched. */
function lastActivity(runs: RunSummary[], items: WorkItemSummary[]): string | null {
  const stamps: string[] = [];
  for (const run of runs) {
    const at = run.endedAt ?? run.startedAt;
    if (at) stamps.push(at);
  }
  for (const item of items) {
    const at = item.updatedAt ?? item.createdAt;
    if (at) stamps.push(at);
  }
  let newest: string | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const stamp of stamps) {
    const ms = Date.parse(stamp);
    if (Number.isNaN(ms)) continue;
    if (ms > newestMs) {
      newestMs = ms;
      newest = stamp;
    }
  }
  return newest;
}

function StateCard({
  autonomy,
  canary,
  activity,
  encoded,
}: {
  autonomy: AutonomyReadWire | null;
  canary: CanaryOverviewWire | null;
  activity: string | null;
  encoded: string;
}) {
  const activeCanary = canary?.active ?? null;
  const lastCanary = canary?.history?.[0] ?? null;
  return (
    <Card testId="dashboard-state">
      <CardHeader
        title="Factory state"
        hint="Autonomy policy in force, canary routing and the newest recorded activity."
        action={
          <Link
            href={`/factories/${encoded}/gates`}
            data-testid="dashboard-state-gates"
            className="text-xs font-medium text-sky-700 underline decoration-sky-200 underline-offset-2"
          >
            Gates
          </Link>
        }
      />
      <CardBody>
        <div className="grid gap-4 md:grid-cols-3">
          <div data-testid="dashboard-autonomy-state">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Autonomy</p>
            {autonomy ? (
              <div className="mt-1 space-y-1">
                <Badge
                  tone={autonomy.paused ? 'warning' : autonomy.enabled ? 'success' : 'neutral'}
                  testId="dashboard-autonomy-badge"
                >
                  {autonomy.paused ? 'paused' : autonomy.enabled ? 'enabled' : 'lights on'}
                </Badge>
                <p className="text-xs text-slate-500">
                  {autonomy.declared.fullyAutonomous ? 'lights off' : 'lights on'} declared · merge{' '}
                  <span className="font-mono">{autonomy.declared.mergePolicy}</span>
                </p>
                {autonomy.overrideActor ? (
                  <p data-testid="dashboard-autonomy-override" className="text-xs text-amber-700">
                    override by {autonomy.overrideActor}
                    {autonomy.overrideReason ? `: ${autonomy.overrideReason}` : ''}
                  </p>
                ) : null}
                {autonomy.updatedAt ? (
                  <p className="text-[11px] text-slate-400">
                    changed <TimeAgo value={autonomy.updatedAt} />
                  </p>
                ) : null}
              </div>
            ) : (
              <p data-testid="dashboard-autonomy-unavailable" className="mt-1 text-xs text-slate-500">
                Autonomy state unavailable.
              </p>
            )}
          </div>

          <div data-testid="dashboard-canary-state">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Canary</p>
            {activeCanary ? (
              <div className="mt-1 space-y-1">
                <Badge tone="info" testId="dashboard-canary-active">
                  active · {activeCanary.rollout.canaryPercent}%
                </Badge>
                <p className="font-mono text-[11px] text-slate-500">{activeCanary.rollout.id}</p>
                {activeCanary.window.endsAt ? (
                  <p className="text-[11px] text-slate-400">
                    ends <TimeAgo value={activeCanary.window.endsAt} />
                  </p>
                ) : null}
              </div>
            ) : lastCanary ? (
              <div className="mt-1 space-y-1">
                <Badge tone={lastCanary.rollout.status === 'promoted' ? 'success' : 'neutral'} testId="dashboard-canary-last">
                  last · {lastCanary.rollout.status}
                </Badge>
                <p className="font-mono text-[11px] text-slate-500">{lastCanary.rollout.id}</p>
                <p className="text-[11px] text-slate-400">
                  ended <TimeAgo value={lastCanary.rollout.endedAt ?? lastCanary.rollout.startedAt} />
                </p>
              </div>
            ) : (
              <p data-testid="dashboard-canary-none" className="mt-1 text-xs text-slate-500">
                No canary rollout yet.
              </p>
            )}
            <Link
              href={`/factories/${encoded}/self-improvement`}
              className="mt-1 inline-block text-[11px] text-sky-700 underline decoration-sky-200 underline-offset-2"
            >
              Canary panel
            </Link>
          </div>

          <div data-testid="dashboard-last-activity">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Last activity</p>
            {activity ? (
              <p className="mt-1 text-sm font-medium text-slate-800">
                <TimeAgo value={activity} />
              </p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">Nothing has run yet.</p>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function WorkItemsCard({ items, encoded }: { items: WorkItemSummary[]; encoded: string }) {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  const statuses = ['active', 'escalated', 'done', 'failed', 'cancelled'];
  return (
    <Card testId="dashboard-work-items">
      <CardHeader
        title="Work items"
        hint="Status counts and the newest items for this factory."
        action={
          <Link
            href={`/work-items?factory=${encoded}`}
            data-testid="dashboard-work-items-link"
            className="text-xs font-medium text-sky-700 underline decoration-sky-200 underline-offset-2"
          >
            Board
          </Link>
        }
      />
      <CardBody className="space-y-3">
        {items.length === 0 ? (
          <EmptyState
            testId="dashboard-work-items-empty"
            title="No work items for this factory"
            description="Create one on the board or let an automation start it; it will appear here."
          />
        ) : (
          <>
            <ul className="flex flex-wrap gap-2" data-testid="dashboard-work-item-counts">
              {statuses.map((status) => (
                <li key={status}>
                  <Badge tone={statusTone(status)} testId={`dashboard-work-items-${status}`}>
                    {status} {counts[status] ?? 0}
                  </Badge>
                </li>
              ))}
            </ul>
            <ul className="divide-y divide-slate-100 text-sm">
              {items.slice(0, RECENT_ITEMS).map((item) => (
                <li
                  key={item.id}
                  data-testid="dashboard-work-item"
                  data-work-item-id={item.id}
                  data-status={item.status}
                  className="flex flex-wrap items-center justify-between gap-2 py-1.5"
                >
                  <Link
                    href={`/work-items/${encodeURIComponent(item.id)}`}
                    data-testid="dashboard-work-item-link"
                    className="min-w-0 flex-1 truncate text-slate-900 underline decoration-slate-300 underline-offset-2"
                  >
                    {item.title}
                  </Link>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-slate-500">{item.stage}</span>
                    <Badge tone={statusTone(item.status)} testId="dashboard-work-item-status">
                      {item.status}
                    </Badge>
                    <TimeAgo
                      className="text-[11px] text-slate-400"
                      testId="dashboard-work-item-updated"
                      value={item.updatedAt}
                    />
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function RunsCard({ runs, encoded }: { runs: RunSummary[]; encoded: string }) {
  return (
    <Card testId="dashboard-runs">
      <CardHeader
        title="Recent runs"
        hint="Newest harness runs, with the harness/model that executed them."
        action={
          <Link
            href={`/runs?factory=${encoded}`}
            data-testid="dashboard-runs-link"
            className="text-xs font-medium text-sky-700 underline decoration-sky-200 underline-offset-2"
          >
            All runs
          </Link>
        }
      />
      <CardBody>
        {runs.length === 0 ? (
          <EmptyState
            testId="dashboard-runs-empty"
            title="No runs for this factory yet"
            description="Dispatch work through New Chat; runs will appear here with status, harness, cost and start time."
          />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {runs.slice(0, RECENT_RUNS).map((run) => (
              <li
                key={run.id}
                data-testid="dashboard-run"
                data-run-id={run.id}
                data-status={run.status}
                className="flex flex-wrap items-center justify-between gap-2 py-1.5"
              >
                <Link
                  href={`/runs/${encodeURIComponent(run.id)}`}
                  data-testid="dashboard-run-link"
                  className="min-w-0 flex-1 truncate text-slate-900 underline decoration-slate-300 underline-offset-2"
                >
                  {run.title ?? run.id}
                </Link>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={statusTone(run.status)} testId="dashboard-run-status">
                    {run.status}
                  </Badge>
                  <span className="font-mono text-[11px] text-slate-500" data-testid="dashboard-run-harness">
                    {run.harness}
                    {run.model ? `/${run.model}` : ''}
                  </span>
                  <span className="text-[11px] text-slate-600" data-testid="dashboard-run-cost">
                    {formatCost(run.costUsd)}
                  </span>
                  <TimeAgo
                    className="text-[11px] text-slate-400"
                    testId="dashboard-run-started"
                    value={run.startedAt}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function DeliverablesCard({
  items,
  artifactRun,
  artifacts,
}: {
  items: WorkItemSummary[];
  artifactRun: RunSummary | null;
  artifacts: RunArtifact[];
}) {
  const prs: { url: string; number: number | null; title: string }[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.prUrl || seen.has(item.prUrl)) continue;
    seen.add(item.prUrl);
    prs.push({ url: item.prUrl, number: item.prNumber, title: item.title });
  }
  const mergedCount = items.filter((item) => item.status === 'done').length;
  const latest = artifacts.find((artifact) => artifact.kind === 'patch') ?? artifacts[0] ?? null;

  return (
    <Card testId="dashboard-deliverables">
      <CardHeader
        title="Deliverables"
        hint="What this factory produced: pull requests, merged items and the latest captured artifact."
      />
      <CardBody className="space-y-3">
        <p className="text-xs text-slate-500" data-testid="dashboard-deliverables-explainer">
          Results live in the pull request and the run&apos;s artifacts: the PR carries the diff and
          checks, and the run detail carries the patch, the event stream and the captured files.
        </p>

        {prs.length === 0 && !latest ? (
          <EmptyState
            testId="dashboard-deliverables-empty"
            title="No deliverables yet"
            description="No pull request and no captured artifact exist for this factory — nothing is claimed that did not happen."
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Pull requests</p>
              {prs.length === 0 ? (
                <p className="mt-1 text-xs text-slate-500">No pull request opened yet.</p>
              ) : (
                <ul className="mt-1 space-y-1 text-sm">
                  {prs.map((pr) => (
                    <li key={pr.url}>
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="dashboard-pr-link"
                        className="font-mono text-[11px] text-emerald-700 underline decoration-emerald-200 underline-offset-2"
                        title={pr.title}
                      >
                        PR #{pr.number ?? '?'} · {pr.url}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Merged</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900" data-testid="dashboard-merged-count">
                {mergedCount}
              </p>
              <p className="text-[11px] text-slate-500">
                item(s) reached <span className="font-mono">done</span> — the ship stage merged them (or
                enqueued them when the integration owns the merge queue).
              </p>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Latest artifact
              </p>
              {latest && artifactRun ? (
                <div className="mt-1 space-y-1">
                  <Link
                    href={`/runs/${encodeURIComponent(artifactRun.id)}`}
                    data-testid="dashboard-artifact"
                    className="block font-mono text-[11px] text-sky-700 underline decoration-sky-200 underline-offset-2"
                  >
                    {latest.path}
                    {latest.bytes !== undefined ? ` · ${latest.bytes} bytes` : ''}
                  </Link>
                  <p className="text-[11px] text-slate-400">
                    from {artifactRun.title ?? artifactRun.id} ·{' '}
                    <TimeAgo value={artifactRun.startedAt} />
                  </p>
                </div>
              ) : (
                <p className="mt-1 text-xs text-slate-500" data-testid="dashboard-artifact-none">
                  No artifact captured on the newest runs.
                </p>
              )}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
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

  const [detail, runs, metrics, workItems, autonomy, canary] = await Promise.all([
    safeGet<{ factory: FactoryDetail } | null>(`/factories/${encoded}`, null),
    safeGet<{ runs: RunSummary[] }>(`/runs?factory=${encoded}&limit=100`, { runs: [] }),
    safeGet<FactoryMetricsResponse | null>(
      `/factories/${encoded}/metrics?window=${encodeURIComponent(windowLabel)}`,
      null,
    ),
    safeGet<{ workItems: WorkItemSummary[] }>(`/work-items?factory=${encoded}&limit=100`, {
      workItems: [],
    }),
    safeGet<{ autonomy: AutonomyReadWire } | null>(`/autonomy?factory=${encoded}`, null),
    safeGet<CanaryOverviewWire | null>(`/factories/${encoded}/canary`, null),
  ]);

  const rows = runs.runs;
  const items = workItems.workItems;
  const counts: Record<string, number> = {};
  for (const run of rows) counts[run.status] = (counts[run.status] ?? 0) + 1;

  const costTotal = rows.reduce((total, run) => total + (run.costUsd ?? 0), 0);
  const inputTokens = rows.reduce((total, run) => total + (run.inputTokens ?? 0), 0);
  const outputTokens = rows.reduce((total, run) => total + (run.outputTokens ?? 0), 0);
  const factory = detail?.factory;

  // Deliverables need artifact metadata, which only the run detail projects. The newest runs
  // are inspected in order; the first one with artifacts is the "latest patch" source.
  const candidates = rows.slice(0, ARTIFACT_SCAN);
  const details = await Promise.all(
    candidates.map((run) => safeGet<RunDetail | null>(`/runs/${encodeURIComponent(run.id)}`, null)),
  );
  let artifactRun: RunSummary | null = null;
  let artifacts: RunArtifact[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const list = (details[index]?.artifacts ?? []) as RunArtifact[];
    if (list.length > 0) {
      artifactRun = candidates[index] ?? null;
      artifacts = list;
      break;
    }
  }

  const activity = lastActivity(rows, items);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {factoryHeading(factory?.alias, factoryName, 'Dashboard')}
          </h1>
          <p className="text-sm text-slate-500">
            Operations view of <span className="font-mono">factories/{factoryName}</span>: state, work,
            runs and deliverables — then the metrics.
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

      <StateCard autonomy={autonomy?.autonomy ?? null} canary={canary} activity={activity} encoded={encoded} />

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

      <WorkItemsCard items={items} encoded={encoded} />

      <RunsCard runs={rows} encoded={encoded} />

      <DeliverablesCard items={items} artifactRun={artifactRun} artifacts={artifacts} />

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
