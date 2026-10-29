import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { safeGet } from '@/lib/api';
import { formatRelative, shortCommit } from '@/lib/format';
import type { PermissionRow, RunDetail, RunSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface InboxItem {
  kind: 'permission' | 'failure';
  runId: string;
  factory: string;
  title: string;
  at: string;
  commit: string;
  action?: string;
  requestId?: string;
  errorCode?: string;
  error?: string;
}

/**
 * Inbox = only what needs *this* user right now. Derived from the run read model, so a
 * retried-successful run disappears without any extra state (spec: "auto-resolves").
 */
export default async function InboxPage() {
  const runs = await safeGet<{ runs: RunSummary[] }>('/runs?limit=100', { runs: [] });

  const openRuns = runs.runs.filter((run) => run.status === 'pending' || run.status === 'running').slice(0, 25);
  const failedRuns = runs.runs.filter((run) => run.status === 'error').slice(0, 25);

  const candidates = [...openRuns, ...failedRuns];
  const details = await Promise.all(
    candidates.map((run) => safeGet<RunDetail | null>(`/runs/${encodeURIComponent(run.id)}`, null)),
  );
  const detailById = new Map<string, RunDetail | null>();
  candidates.forEach((run, index) => detailById.set(run.id, details[index] ?? null));

  const items: InboxItem[] = [];

  for (const run of openRuns) {
    const detail = detailById.get(run.id);
    if (!detail) continue;
    for (const permission of detail.pendingPermissions as PermissionRow[]) {
      items.push({
        kind: 'permission',
        runId: run.id,
        factory: run.factory,
        title: run.title ?? run.id,
        at: permission.requested_at,
        commit: run.definitionCommit,
        action: permission.action,
        requestId: permission.request_id,
      });
    }
  }

  for (const run of failedRuns) {
    const detail = detailById.get(run.id);
    const error = detail?.run.error ?? null;
    items.push({
      kind: 'failure',
      runId: run.id,
      factory: run.factory,
      title: run.title ?? run.id,
      at: run.endedAt ?? run.startedAt,
      commit: run.definitionCommit,
      errorCode: error ? (error.split(':')[0]?.trim() || 'run_failed') : 'run_failed',
      error: error ?? 'the run ended with status error',
    });
  }

  items.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));

  const pendingPermissions = items.filter((item) => item.kind === 'permission');
  const failures = items.filter((item) => item.kind === 'failure');

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-6">
      <header>
        <h1 className="text-lg font-semibold text-slate-900">Inbox</h1>
        <p className="text-sm text-slate-500">
          Items that need you: unanswered permission requests and failed runs. Everything else is
          visible under Runs.
        </p>
      </header>

      {items.length === 0 ? (
        <EmptyState
          testId="inbox-empty"
          title="Nothing needs your attention"
          description="No pending permissions and no failed runs. New items appear here as soon as an agent asks for a decision."
          action={
            <Link
              href="/runs"
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Browse runs
            </Link>
          }
        />
      ) : (
        <>
          <Card testId="inbox-permissions">
            <CardHeader
              title={`Pending permissions (${pendingPermissions.length})`}
              hint="An agent is blocked until you decide."
            />
            {pendingPermissions.length === 0 ? (
              <p className="px-5 py-4 text-sm text-slate-500">No pending permissions.</p>
            ) : (
              <ul data-testid="inbox-list" className="divide-y divide-slate-100">
                {pendingPermissions.map((item) => (
                  <li
                    key={`${item.runId}:${item.requestId}`}
                    data-testid="inbox-item"
                    data-kind="permission"
                    data-run-id={item.runId}
                    data-request-id={item.requestId}
                    className="flex flex-wrap items-center gap-3 px-5 py-3"
                  >
                    <Badge tone="warning" testId="inbox-item-kind">
                      permission
                    </Badge>
                    <Link
                      href={`/runs/${item.runId}?focus=permission:${encodeURIComponent(item.requestId ?? '')}`}
                      data-testid="inbox-item-link"
                      className="text-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-2"
                    >
                      {item.title}
                    </Link>
                    <span className="font-mono text-xs text-slate-500">{item.action}</span>
                    <span className="font-mono text-[11px] text-slate-400">
                      {item.factory}@{shortCommit(item.commit)}
                    </span>
                    <span className="ml-auto text-xs text-slate-500" data-testid="inbox-item-age">
                      {formatRelative(item.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card testId="inbox-failures">
            <CardHeader
              title={`Failed runs (${failures.length})`}
              hint="Resolves automatically when a retry succeeds."
            />
            {failures.length === 0 ? (
              <p className="px-5 py-4 text-sm text-slate-500">No failed runs.</p>
            ) : (
              <ul data-testid="inbox-failures-list" className="divide-y divide-slate-100">
                {failures.map((item) => (
                  <li
                    key={item.runId}
                    data-testid="inbox-item"
                    data-kind="failure"
                    data-run-id={item.runId}
                    data-error-code={item.errorCode}
                    className="flex flex-wrap items-center gap-3 px-5 py-3"
                  >
                    <Badge tone="danger" testId="inbox-item-kind">
                      failure
                    </Badge>
                    <Link
                      href={`/runs/${item.runId}`}
                      data-testid="inbox-item-link"
                      className="text-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-2"
                    >
                      {item.title}
                    </Link>
                    <span className="font-mono text-xs text-red-700" data-testid="inbox-error-code">
                      {item.errorCode}
                    </span>
                    <span className="ml-auto text-xs text-slate-500" data-testid="inbox-item-age">
                      {formatRelative(item.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
