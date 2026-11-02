import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { safeGet } from '@/lib/api';
import { factoryNameOf, loadFactory } from '@/lib/factory-page';
import { formatCost, shortCommit, statusTone } from '@/lib/format';
import { ElapsedTime, TimeAgo } from '@/components/ui/TimeAgo';
import type { RunSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

const STATUSES = ['running', 'pending', 'ok', 'error', 'cancelled'] as const;

/** Factory-scoped runs list: `/factories/:id/runs` (change `add-factory-identity`). */
export default async function RunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { id } = await params;
  const { status } = await searchParams;
  const factoryId = decodeURIComponent(id);
  const encoded = encodeURIComponent(factoryId);
  const basePath = `/factories/${encoded}/runs`;

  const query = new URLSearchParams({ limit: '50' });
  if (status) query.set('status', status);

  const [factory, runs] = await Promise.all([
    loadFactory(factoryId),
    safeGet<{ runs: RunSummary[] }>(`${basePath}?${query.toString()}`, { runs: [] }),
  ]);
  const factoryName = factoryNameOf(factory, factoryId);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{factoryName} › Runs</h1>
          <p className="text-sm text-slate-500">
            Every run pins a <span className="font-mono">definitionCommit</span>; newest first.
          </p>
        </div>
        <Link
          href={`/chat?factory=${encoded}`}
          data-testid="runs-new-chat"
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-300"
        >
          New Chat
        </Link>
      </header>

      <form
        method="get"
        action={basePath}
        data-testid="runs-filters"
        className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
      >
        <div>
          <label htmlFor="filter-status" className="block text-xs font-medium text-slate-600">
            Status
          </label>
          <select
            id="filter-status"
            name="status"
            data-testid="runs-filter-status"
            defaultValue={status ?? ''}
            className="mt-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">All statuses</option>
            {STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          data-testid="runs-filter-submit"
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400"
        >
          Filter
        </button>
        {status ? (
          <Link
            href={basePath}
            data-testid="runs-filter-clear"
            className="text-sm text-slate-500 underline decoration-slate-300 underline-offset-2"
          >
            Clear
          </Link>
        ) : null}
      </form>

      <Card testId="runs-list">
        <Table
          testId="runs-table"
          rowTestId="run-row"
          rows={runs.runs}
          rowKey={(run) => run.id}
          empty={
            <EmptyState
              testId="runs-empty"
              title="No runs yet"
              description="Start a chat or dispatch a factory run; it will appear here newest-first."
              action={
                <Link
                  href={`/chat?factory=${encoded}`}
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Open New Chat
                </Link>
              }
            />
          }
          columns={[
            {
              header: 'Status',
              cell: (run) => (
                <span data-testid="run-row-status">
                  <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                </span>
              ),
            },
            {
              header: 'Run',
              cell: (run) => (
                <Link
                  href={`${basePath}/${encodeURIComponent(run.id)}`}
                  data-testid="run-row-link"
                  data-run-id={run.id}
                  data-started-at={run.startedAt}
                  data-status={run.status}
                  className="block"
                >
                  <span className="block text-sm font-medium text-slate-900">
                    {run.title ?? run.id}
                  </span>
                  <span className="block font-mono text-[11px] text-slate-400">{run.id}</span>
                </Link>
              ),
            },
            {
              header: 'Kind',
              cell: (run) => <span className="font-mono text-xs text-slate-600">{run.kind}</span>,
            },
            {
              header: 'Commit',
              cell: (run) => (
                <span data-testid="run-row-commit" className="font-mono text-xs text-slate-600">
                  {shortCommit(run.definitionCommit)}
                  {run.definitionDirty ? '*' : ''}
                </span>
              ),
            },
            {
              header: 'Started',
              cell: (run) => (
                <TimeAgo value={run.startedAt} className="text-xs text-slate-600" />
              ),
            },
            {
              header: 'Duration',
              cell: (run) => (
                <span className="text-xs text-slate-600">
                  <ElapsedTime startedAt={run.startedAt} endedAt={run.endedAt} />
                </span>
              ),
            },
            {
              header: 'Cost',
              cell: (run) => (
                <span data-testid="run-row-cost" className="text-xs text-slate-600">
                  {formatCost(run.costUsd)}
                </span>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
