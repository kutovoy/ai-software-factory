import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { safeGet } from '@/lib/api';
import { formatCost, formatTokens, shortCommit } from '@/lib/format';
import type { FactoryDetail, RunSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

const STATUS_ORDER = ['ok', 'error', 'cancelled', 'running', 'pending'] as const;

export default async function DashboardPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const factoryName = decodeURIComponent(name);

  const [detail, runs] = await Promise.all([
    safeGet<{ factory: FactoryDetail } | null>(
      `/factories/${encodeURIComponent(factoryName)}`,
      null,
    ),
    safeGet<{ runs: RunSummary[] }>(`/runs?factory=${encodeURIComponent(factoryName)}&limit=100`, {
      runs: [],
    }),
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
            {factory?.alias ?? factoryName} <span className="text-slate-400">›</span> Dashboard
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
              href={`/chat?factory=${encodeURIComponent(factoryName)}`}
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
    </div>
  );
}
