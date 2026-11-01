import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { CancelWorkItemButton } from '@/components/work-items/CancelWorkItemButton';
import { CreateWorkItemForm } from '@/components/work-items/CreateWorkItemForm';
import { SlaCountdown } from '@/components/work-items/SlaCountdown';
import { getOrError, safeGet } from '@/lib/api';
import { shortCommit, statusTone } from '@/lib/format';
import { TimeAgo } from '@/components/ui/TimeAgo';
import type { FactoryListItem, WorkItemDetail, WorkItemSummary } from '@/lib/types';
import { WORK_ITEM_STAGES } from '@/lib/types';
import { runsForWorkItem } from '@/lib/work-items';

export const dynamic = 'force-dynamic';

/** The board shows the newest 40 visible items; details (runs, pending gate) are per card. */
const BOARD_LIMIT = 40;
/** The list is fetched wider than the board so the status filter can drop cancelled items. */
const FETCH_LIMIT = 100;

/** Status chips (`web-console` spec: "Work-item board filters"). */
const STATUS_FILTERS = ['active', 'escalated', 'done', 'failed', 'cancelled'] as const;
/** Default view: everything except cancelled. */
const DEFAULT_STATUSES = STATUS_FILTERS.filter((status) => status !== 'cancelled');

function parseStatuses(value: string | undefined): Set<string> | null {
  if (value === undefined) return null;
  return new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function statusesHref(factory: string | undefined, statuses: Iterable<string>): string {
  const query = new URLSearchParams();
  if (factory) query.set('factory', factory);
  query.set('status', Array.from(statuses).join(','));
  return `/work-items?${query.toString()}`;
}

const COLUMN_HINTS: Record<string, string> = {
  triage: 'Intake judgement and classification.',
  spec: 'Scope, acceptance criteria, definition commit.',
  plan: 'Approach and task breakdown.',
  implement: 'Branch, commit and pull request.',
  review: 'Two independent reviewers + an advisory judge.',
  verify: 'Forge checks; red checks stop the loop.',
  ship: 'Merge gate — the only place a PR merges.',
};

export default async function WorkItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ factory?: string; status?: string }>;
}) {
  const { factory, status } = await searchParams;

  const query = new URLSearchParams({ limit: String(FETCH_LIMIT) });
  if (factory) query.set('factory', factory);

  const [list, factories] = await Promise.all([
    getOrError<{ workItems: WorkItemSummary[] }>(`/work-items?${query.toString()}`),
    safeGet<{ factories: FactoryListItem[] }>('/factories', { factories: [] }),
  ]);

  const fetched = list.data?.workItems ?? [];

  // `status` is the explicit chip selection; absent means "everything except cancelled".
  const selected = parseStatuses(status);
  const isVisible = (item: WorkItemSummary): boolean =>
    selected ? selected.has(item.status) : item.status !== 'cancelled';
  const visible = fetched.filter(isVisible).slice(0, BOARD_LIMIT);

  const details = await Promise.all(
    visible.map((item) =>
      safeGet<WorkItemDetail | null>(`/work-items/${encodeURIComponent(item.id)}`, null),
    ),
  );

  const cards = visible.map((item, index) => {
    const detail = details[index] ?? null;
    const events = detail?.events ?? [];
    return {
      item,
      pendingGate: detail?.pendingGate ?? null,
      runs: runsForWorkItem(item.id, events),
      prUrl: item.prUrl,
    };
  });

  const countsByStatus: Record<string, number> = {};
  for (const item of fetched) countsByStatus[item.status] = (countsByStatus[item.status] ?? 0) + 1;

  const byStage = new Map<string, typeof cards>();
  for (const card of cards) {
    const bucket = byStage.get(card.item.stage);
    if (bucket) bucket.push(card);
    else byStage.set(card.item.stage, [card]);
  }

  return (
    <div className="mx-auto max-w-[110rem] space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Work items</h1>
          <p className="text-sm text-slate-500">
            One durable workflow per item: stages advance through the compiled graph, and a gate
            decides whether the loop continues. Cancelled items are hidden by default; the status
            chips narrow the board, and each card shows when it was created and last updated.
          </p>
        </div>
        <Badge tone="neutral" testId="work-items-count">
          {visible.length} of {fetched.length} item{fetched.length === 1 ? '' : 's'}
        </Badge>
      </header>

      <Card testId="work-items-create-card">
        <CardHeader
          title="New work item (manual)"
          hint="Persisted first, then started as a workflow — the card survives a worker restart."
        />
        <div className="px-5 py-4">
          <CreateWorkItemForm
            factories={factories.factories.map((entry) => entry.name)}
            defaultFactory={factory ?? factories.factories[0]?.name ?? 'example'}
          />
        </div>
      </Card>

      <form
        method="get"
        action="/work-items"
        data-testid="work-items-filter"
        className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
      >
        <div>
          <label htmlFor="filter-factory" className="block text-xs font-medium text-slate-600">
            Factory
          </label>
          <select
            id="filter-factory"
            name="factory"
            data-testid="work-items-filter-factory"
            defaultValue={factory ?? ''}
            className="mt-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">All factories</option>
            {factories.factories.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          data-testid="work-items-filter-submit"
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          Filter
        </button>
        {factory ? (
          <Link
            href="/work-items"
            data-testid="work-items-filter-clear"
            className="text-sm text-slate-500 underline decoration-slate-300 underline-offset-2"
          >
            Clear
          </Link>
        ) : null}
      </form>

      <nav data-testid="work-items-status-filters" aria-label="Status filters" className="flex flex-wrap items-center gap-1">
        <Link
          href={statusesHref(factory, STATUS_FILTERS)}
          data-testid="work-items-status-all"
          data-active={
            selected && STATUS_FILTERS.every((entry) => selected.has(entry)) ? 'true' : 'false'
          }
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            selected && STATUS_FILTERS.every((entry) => selected.has(entry))
              ? 'bg-slate-900 text-white'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          all
        </Link>
        {STATUS_FILTERS.map((entry) => {
          const active = selected ? selected.has(entry) : entry !== 'cancelled';
          // Toggling a chip starts from the current selection (or the default set).
          const next = new Set<string>(selected ?? DEFAULT_STATUSES);
          if (next.has(entry)) next.delete(entry);
          else next.add(entry);
          return (
            <Link
              key={entry}
              href={statusesHref(factory, next)}
              data-testid={`work-items-status-${entry}`}
              data-active={active ? 'true' : 'false'}
              aria-pressed={active}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                active
                  ? entry === 'cancelled'
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {entry} {countsByStatus[entry] ?? 0}
            </Link>
          );
        })}
      </nav>

      {list.error ? (
        <EmptyState
          testId="work-items-unavailable"
          title="Work items are unavailable"
          description={`The API could not be read (${list.error.code}). The board is a projection — it never invents items.`}
        />
      ) : fetched.length === 0 ? (
        <EmptyState
          testId="work-items-empty"
          title="No work items yet"
          description="Create one above; it enters triage and the board fills as the loop advances."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          testId="work-items-filter-empty"
          title="No items match these filters"
          description={`${fetched.length} item(s) exist, but none has a selected status${
            factory ? ` for ${factory}` : ''
          }. Widen the status chips or clear the factory filter.`}
          action={
            <Link
              href={statusesHref(factory, STATUS_FILTERS)}
              data-testid="work-items-filter-reset"
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Show all statuses
            </Link>
          }
        />
      ) : (
        <div
          data-testid="work-items-board"
          className="grid grid-flow-col auto-cols-[minmax(16rem,1fr)] gap-3 overflow-x-auto pb-2"
        >
          {WORK_ITEM_STAGES.map((stage) => {
            const column = byStage.get(stage) ?? [];
            return (
              <section
                key={stage}
                data-testid="board-column"
                data-stage={stage}
                className="flex min-h-[10rem] flex-col rounded-xl border border-slate-200 bg-white"
              >
                <div className="border-b border-slate-100 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-mono text-xs font-semibold uppercase tracking-wide text-slate-700">
                      {stage}
                    </h2>
                    <span data-testid="board-column-count" className="text-xs text-slate-400">
                      {column.length}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-400">{COLUMN_HINTS[stage]}</p>
                </div>

                <div className="flex-1 space-y-2 px-2 py-2">
                  {column.length === 0 ? (
                    <p data-testid="board-column-empty" className="px-1 py-2 text-[11px] text-slate-400">
                      Empty
                    </p>
                  ) : (
                    column.map(({ item, pendingGate, runs }) => (
                      <article
                        key={item.id}
                        data-testid="work-item-card"
                        data-work-item-id={item.id}
                        data-stage={item.stage}
                        data-status={item.status}
                        data-factory={item.factory}
                        className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge tone={statusTone(item.status)} testId="work-item-card-status">
                            {item.status}
                          </Badge>
                          <Badge tone="neutral" testId="work-item-card-type">
                            {item.type}
                          </Badge>
                          <Badge tone="info" testId="work-item-card-source">
                            {item.source}
                          </Badge>
                          {item.loopCount > 0 ? (
                            <Badge tone="warning" testId="work-item-card-loops">
                              loop ×{item.loopCount}
                            </Badge>
                          ) : null}
                        </div>

                        <Link
                          href={`/work-items/${encodeURIComponent(item.id)}`}
                          data-testid="work-item-card-link"
                          className="mt-1 block text-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-2"
                        >
                          {item.title}
                        </Link>

                        <p className="font-mono text-[11px] text-slate-400">{item.id}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                          <span data-testid="work-item-card-factory" className="font-mono">
                            {item.factory}@{shortCommit(item.definitionCommit)}
                          </span>
                          <TimeAgo
                            testId="work-item-card-age"
                            value={item.createdAt}
                            prefix="created "
                          />
                          <TimeAgo
                            testId="work-item-card-updated"
                            value={item.updatedAt}
                            prefix="updated "
                          />
                        </p>

                        {pendingGate ? (
                          <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                            <Badge tone="warning" testId="work-item-card-pending-gate">
                              gate: {pendingGate.stage} · {pendingGate.gate}
                            </Badge>
                            <SlaCountdown
                              slaAt={pendingGate.slaAt}
                              testId="work-item-card-sla"
                            />
                          </p>
                        ) : null}

                        {runs.length > 0 ? (
                          <ul data-testid="work-item-card-runs" className="mt-1 space-y-0.5">
                            {runs.slice(0, 4).map((run) => (
                              <li key={run.runId}>
                                <Link
                                  href={`/runs/${encodeURIComponent(run.runId)}`}
                                  data-testid="work-item-card-run-link"
                                  className="font-mono text-[11px] text-sky-700 underline decoration-sky-200 underline-offset-2"
                                >
                                  {run.label}
                                </Link>
                              </li>
                            ))}
                            {runs.length > 4 ? (
                              <li className="text-[11px] text-slate-400">
                                +{runs.length - 4} more on the detail page
                              </li>
                            ) : null}
                          </ul>
                        ) : (
                          <p data-testid="work-item-card-runs-empty" className="mt-1 text-[11px] text-slate-400">
                            No runs recorded yet.
                          </p>
                        )}

                        <CancelWorkItemButton
                          workItemId={item.id}
                          status={item.status}
                          cancelRequestedAt={item.cancelRequestedAt ?? null}
                        />

                        {item.prUrl ? (
                          <a
                            href={item.prUrl}
                            target="_blank"
                            rel="noreferrer"
                            data-testid="work-item-card-pr"
                            className="mt-1 block font-mono text-[11px] text-emerald-700 underline decoration-emerald-200 underline-offset-2"
                          >
                            PR #{item.prNumber ?? '?'} · {item.prUrl}
                          </a>
                        ) : null}
                      </article>
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
