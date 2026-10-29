import Link from 'next/link';
import { MergeQueueRevertButton } from '@/components/merge/MergeQueueRevertButton';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { safeGet } from '@/lib/api';
import type {
  FactoryDetail,
  MergeBatchItemWire,
  MergeBatchWire,
  MergeQueueResponseWire,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'danger' | 'warning' | 'info'> = {
  merged: 'success',
  bisected: 'warning',
  reverted: 'warning',
  checks_timeout: 'danger',
  failed: 'danger',
  merging: 'info',
  verifying: 'info',
  queued: 'neutral',
};

const ITEM_TONE: Record<string, 'neutral' | 'success' | 'danger' | 'warning' | 'info'> = {
  merged: 'success',
  needs_human: 'danger',
  failed: 'danger',
  reverted: 'warning',
  queued: 'neutral',
  batched: 'info',
};

function checksSummary(batch: MergeBatchWire): string {
  if (batch.checks.length === 0) return '—';
  return batch.checks.map((check) => `${check.name}:${check.conclusion}`).join(' · ');
}

function evidenceSummary(batch: MergeBatchWire): string | null {
  const evidence = batch.evidence ?? {};
  const parts: string[] = [];
  if (Array.isArray(evidence.mergedPrs) && evidence.mergedPrs.length > 0) {
    parts.push(`kept #${(evidence.mergedPrs as number[]).join(', #')}`);
  }
  if (Array.isArray(evidence.offenders) && evidence.offenders.length > 0) {
    parts.push(`offender #${(evidence.offenders as number[]).join(', #')}`);
  }
  if (typeof evidence.revertSha === 'string') parts.push(`revert ${evidence.revertSha.slice(0, 8)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function itemEvidence(item: MergeBatchItemWire): string | null {
  const evidence = item.evidence ?? {};
  const failing = Array.isArray(evidence.failing) ? (evidence.failing as string[]) : [];
  if (failing.length > 0) return `failing: ${failing.join(', ')}`;
  if (typeof evidence.reason === 'string') return evidence.reason;
  return null;
}

export default async function MergeQueuePage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const factory = decodeURIComponent(name);
  const encoded = encodeURIComponent(factory);

  const [detail, queue] = await Promise.all([
    safeGet<{ factory: FactoryDetail } | null>(`/factories/${encoded}`, null),
    safeGet<MergeQueueResponseWire | null>(`/factories/${encoded}/merge-queue`, null),
  ]);

  const batches = queue?.batches ?? [];
  const queued = queue?.queued ?? [];
  const mergePolicy = detail?.factory.manifest.mergePolicy ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {detail?.factory.alias ?? factory} <span className="text-slate-400">›</span> Merge queue
          </h1>
          <p className="text-sm text-slate-500">
            Agents open pull requests; the queue owns merges. Batches are serialized, the merged stack is
            gated, a red stack is bisected, and a batch can be reverted as one commit.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" testId="merge-queue-batch-size">
            batch size {queue?.batchSize ?? 2}
          </Badge>
          <Badge tone="neutral" testId="merge-queue-checks-timeout">
            checks timeout {Math.round((queue?.checksTimeoutMs ?? 0) / 1000)}s
          </Badge>
          <Badge
            tone={queue?.inFlight ? 'info' : 'neutral'}
            testId="merge-queue-inflight"
          >
            {queue?.inFlight ? `in flight · ${queue.inFlight.status}` : 'idle'}
          </Badge>
        </div>
      </header>

      {mergePolicy ? (
        <div
          data-testid="merge-queue-policy"
          className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700"
        >
          Merge policy: <span className="font-mono text-xs">{mergePolicy}</span>. A queued pull request is
          merged only by the queue — no stage writes the default branch (ADR-022).
        </div>
      ) : null}

      {queue?.workflow ? (
        <p data-testid="merge-queue-workflow" className="text-xs text-slate-500">
          Queue workflow: <span className="font-mono">{queue.workflow.workflowId}</span> ·{' '}
          {queue.workflow.status}
        </p>
      ) : (
        <p data-testid="merge-queue-workflow-idle" className="text-xs text-slate-500">
          No queue workflow run yet — the next enqueued pull request starts one.
        </p>
      )}

      <Card testId="merge-queue-waiting">
        <CardHeader
          title="Waiting for the next batch"
          hint="Only one batch may be in flight; these pull requests are picked up in order."
        />
        <CardBody>
          {queued.length === 0 ? (
            <EmptyState
              testId="merge-queue-waiting-empty"
              title="Queue is empty"
              description="No pull request is waiting. A work item whose ship stage enqueues a PR appears here."
            />
          ) : (
            <Table
              testId="merge-queue-waiting-table"
              rowTestId="merge-queue-waiting-row"
              rows={queued}
              rowKey={(row) => row.id}
              columns={[
                {
                  header: 'PR',
                  cell: (row) => (
                    <span className="font-mono text-xs text-slate-800">#{row.prNumber}</span>
                  ),
                },
                { header: 'Head', cell: (row) => <span className="font-mono text-[11px]">{row.head}</span> },
                {
                  header: 'Work item',
                  cell: (row) =>
                    row.workItemId ? (
                      <Link
                        href={`/work-items/${encodeURIComponent(row.workItemId)}`}
                        className="font-mono text-[11px] text-slate-900 underline decoration-slate-300 underline-offset-2"
                      >
                        {row.workItemId}
                      </Link>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    ),
                },
                {
                  header: 'Status',
                  cell: (row) => (
                    <Badge tone={ITEM_TONE[row.status] ?? 'neutral'} testId="merge-queue-waiting-status">
                      {row.status}
                    </Badge>
                  ),
                },
              ]}
            />
          )}
        </CardBody>
      </Card>

      <Card testId="merge-queue-batches">
        <CardHeader
          title="Batches"
          hint="Newest first. A batch merges as a unit; the merged stack must pass the required checks."
        />
        <CardBody className="space-y-4">
          {batches.length === 0 ? (
            <EmptyState
              testId="merge-queue-empty"
              title="No merge batches yet"
              description="Batches appear once the queue has merged (or tried to merge) a pull request."
            />
          ) : (
            batches.map((batch) => {
              const summary = evidenceSummary(batch);
              const canRevert = batch.status === 'merged' || batch.status === 'bisected';
              return (
                <div
                  key={batch.id}
                  data-testid="merge-queue-batch"
                  data-status={batch.status}
                  className="rounded-lg border border-slate-200"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-slate-900">{batch.id}</span>
                      <Badge tone={STATUS_TONE[batch.status] ?? 'neutral'} testId="merge-queue-batch-status">
                        {batch.status}
                      </Badge>
                      <span className="font-mono text-[11px] text-slate-500">{batch.repo}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                      <span data-testid="merge-queue-batch-base">
                        base {batch.baseSha?.slice(0, 8) ?? '—'}
                      </span>
                      <span data-testid="merge-queue-batch-merge">
                        merge {batch.mergeSha?.slice(0, 8) ?? '—'}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-3 px-4 py-3">
                    <p data-testid="merge-queue-batch-checks" className="text-xs text-slate-700">
                      <span className="font-semibold">Checks:</span> {checksSummary(batch)}
                    </p>
                    {summary ? (
                      <p data-testid="merge-queue-batch-bisect" className="text-xs text-amber-800">
                        <span className="font-semibold">Bisect:</span> {summary}
                      </p>
                    ) : null}
                    {batch.reason ? (
                      <p data-testid="merge-queue-batch-reason" className="text-xs text-slate-600">
                        {batch.reason}
                      </p>
                    ) : null}

                    <Table
                      testId="merge-queue-items-table"
                      rowTestId="merge-queue-item-row"
                      rows={batch.items}
                      rowKey={(row) => row.id}
                      columns={[
                        {
                          header: 'PR',
                          cell: (row) => (
                            <span className="font-mono text-xs">#{row.prNumber}</span>
                          ),
                        },
                        {
                          header: 'Head',
                          cell: (row) => <span className="font-mono text-[11px]">{row.head}</span>,
                        },
                        {
                          header: 'Status',
                          cell: (row) => (
                            <Badge tone={ITEM_TONE[row.status] ?? 'neutral'} testId="merge-queue-item-status">
                              {row.status}
                            </Badge>
                          ),
                        },
                        {
                          header: 'Evidence',
                          cell: (row) => {
                            const evidence = itemEvidence(row);
                            return (
                              <span data-testid="merge-queue-item-evidence" className="text-[11px] text-slate-600">
                                {evidence ?? '—'}
                              </span>
                            );
                          },
                        },
                        {
                          header: 'Work item',
                          cell: (row) =>
                            row.workItemId ? (
                              <Link
                                href={`/work-items/${encodeURIComponent(row.workItemId)}`}
                                className="font-mono text-[11px] text-slate-900 underline decoration-slate-300 underline-offset-2"
                              >
                                {row.workItemId}
                              </Link>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            ),
                        },
                      ]}
                    />

                    {canRevert ? (
                      <MergeQueueRevertButton factory={factory} batchId={batch.id} />
                    ) : null}

                    {batch.events.length > 0 ? (
                      <ul className="space-y-0.5">
                        {batch.events.map((event) => (
                          <li
                            key={event.id}
                            data-testid="merge-queue-event"
                            data-type={event.type}
                            className="font-mono text-[11px] text-slate-500"
                          >
                            {event.type}
                            {event.subject ? ` · ${event.subject}` : ''}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </CardBody>
      </Card>

      <p className="text-xs text-slate-500">
        A batch that never reports within the checks timeout fails <span className="font-mono">checks_timeout</span>{' '}
        and nothing merges. Each pull request is merged and then the merged stack is gated: on red the queue
        reverts just that merge (one commit) and marks the pull request{' '}
        <span className="font-mono">needs_human</span> with its failing checks, while the rest of the batch
        keeps merging.
      </p>
    </div>
  );
}
