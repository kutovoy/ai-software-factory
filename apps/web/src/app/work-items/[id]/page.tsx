import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { GateDecisionActions } from '@/components/work-items/GateDecisionActions';
import { SlaCountdown } from '@/components/work-items/SlaCountdown';
import { ApiClientError, apiGet } from '@/lib/api';
import { formatDateTime, formatRelative, shortCommit, statusTone } from '@/lib/format';
import type { GateDecisionRecord, WorkItemDetail } from '@/lib/types';
import {
  checksRecorded,
  judgeVerdict,
  lastAutonomyEvent,
  mergedAt,
  prOpened,
  reviewerReports,
  runsForWorkItem,
  slaState,
  stageTimeline,
  statusEvents,
} from '@/lib/work-items';

export const dynamic = 'force-dynamic';

export default async function WorkItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let detail: WorkItemDetail;
  try {
    detail = await apiGet<WorkItemDetail>(`/work-items/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) notFound();
    throw error;
  }

  const { workItem, events, gates, pendingGate } = detail;
  const transitions = stageTimeline(events);
  const reports = reviewerReports(events);
  const judge = judgeVerdict(events);
  const checks = checksRecorded(events);
  const pr = prOpened(events);
  const merged = mergedAt(events);
  const autonomy = lastAutonomyEvent(events);
  const runs = runsForWorkItem(workItem.id, events);
  const statuses = statusEvents(events);
  const pendingSla = pendingGate ? slaState(pendingGate.slaAt) : null;

  return (
    <div data-testid="work-item-detail" data-work-item-id={workItem.id} className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 data-testid="work-item-title" className="text-lg font-semibold text-slate-900">
              {workItem.title}
            </h1>
            <Badge tone={statusTone(workItem.status)} testId="work-item-status">
              {workItem.status}
            </Badge>
            <Badge tone="info" testId="work-item-stage">
              {workItem.stage}
            </Badge>
            <Badge tone="neutral" testId="work-item-type">
              {workItem.type}
            </Badge>
            <Badge tone="neutral" testId="work-item-source">
              {workItem.source}
            </Badge>
            {workItem.loopCount > 0 ? (
              <Badge tone="warning" testId="work-item-loop-count">
                loop ×{workItem.loopCount}
              </Badge>
            ) : null}
            {merged ? (
              <Badge tone="success" testId="work-item-merged">
                merged · {formatDateTime(merged)}
              </Badge>
            ) : (
              <Badge tone="neutral" testId="work-item-not-merged">
                not merged
              </Badge>
            )}
          </div>
          <p className="font-mono text-xs text-slate-500" data-testid="work-item-id">
            {workItem.id}
          </p>
        </div>
        <Link
          href="/work-items"
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          Back to board
        </Link>
      </header>

      <Card testId="work-item-meta">
        <CardBody className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Factory</p>
            <Link
              href={`/factories/${encodeURIComponent(workItem.factory)}/dashboard`}
              className="font-mono text-sm text-slate-800 underline decoration-slate-300 underline-offset-2"
            >
              {workItem.factory}
            </Link>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Pinned commit</p>
            <p data-testid="work-item-commit" className="font-mono text-sm text-slate-800">
              {shortCommit(workItem.definitionCommit)}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Loop count</p>
            <p data-testid="work-item-loop-value" className="text-sm text-slate-800">
              {workItem.loopCount}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Created</p>
            <p data-testid="work-item-created" className="text-sm text-slate-800">
              {formatRelative(workItem.createdAt)}
            </p>
          </div>
          <div className="md:col-span-2">
            <p className="text-xs uppercase tracking-wide text-slate-400">Pull request</p>
            {workItem.prUrl ? (
              <a
                href={workItem.prUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="work-item-pr"
                data-pr-number={workItem.prNumber ?? ''}
                className="font-mono text-sm text-emerald-700 underline decoration-emerald-200 underline-offset-2"
              >
                #{workItem.prNumber ?? '?'} · {workItem.prUrl}
              </a>
            ) : (
              <p data-testid="work-item-pr-empty" className="text-sm text-slate-500">
                No pull request opened yet{pr ? '' : ' — the implement stage has not run'}.
              </p>
            )}
          </div>
          <div className="md:col-span-2">
            <p className="text-xs uppercase tracking-wide text-slate-400">Source reference</p>
            <p data-testid="work-item-source-ref" className="font-mono text-xs text-slate-600">
              {Object.keys(workItem.sourceRef ?? {}).length > 0
                ? JSON.stringify(workItem.sourceRef)
                : 'none recorded'}
            </p>
            {workItem.parentId ? (
              <p className="mt-1 text-xs text-slate-500">
                Child of{' '}
                <Link
                  href={`/work-items/${encodeURIComponent(workItem.parentId)}`}
                  data-testid="work-item-parent"
                  className="font-mono underline decoration-slate-300 underline-offset-2"
                >
                  {workItem.parentId}
                </Link>
              </p>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card testId="work-item-autonomy-card">
        <CardHeader
          title="Autonomy state"
          hint="Kill switch and lights-off policy for this item."
        />
        <CardBody>
          {autonomy ? (
            <div data-testid="work-item-autonomy" data-state={autonomy.type} className="space-y-1 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone={autonomy.type === 'autonomy.paused' ? 'warning' : 'success'}>
                  {autonomy.type.replace('autonomy.', '')}
                </Badge>
                <span className="font-mono text-xs text-slate-600">
                  {autonomy.actor ?? 'unknown actor'}
                </span>
                <span className="text-xs text-slate-500">{formatDateTime(autonomy.at)}</span>
              </p>
              <p className="text-xs text-slate-600">
                {autonomy.reason ?? 'no reason recorded'}
              </p>
            </div>
          ) : (
            <p data-testid="work-item-autonomy-empty" className="text-sm text-slate-500">
              No autonomy change is recorded for this item. The API exposes the kill switch as{' '}
              <span className="font-mono">POST /autonomy</span>; there is no autonomy read endpoint yet, so
              this panel shows only what the event log proves.
            </p>
          )}
        </CardBody>
      </Card>

      <Card testId="work-item-gate-card">
        <CardHeader
          title="Pending gate"
          hint="A durable workflow wait: no activity slot is held while a human decides."
        />
        <CardBody>
          {pendingGate ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="warning" testId="work-item-pending-gate">
                  {pendingGate.stage} · {pendingGate.gate}
                </Badge>
                <span className="font-mono text-xs text-slate-500">attempt {pendingGate.attempt}</span>
                <span className="text-xs text-slate-500" data-testid="work-item-pending-gate-age">
                  waiting {formatRelative(pendingGate.requestedAt)}
                </span>
                <SlaCountdown slaAt={pendingGate.slaAt} testId="work-item-pending-gate-sla" />
              </div>
              <GateDecisionActions
                workItemId={workItem.id}
                stage={pendingGate.stage}
                slaLabel={pendingSla?.label}
              />
            </div>
          ) : (
            <EmptyState
              testId="work-item-pending-gate-empty"
              title="No gate is waiting"
              description={
                workItem.status === 'active'
                  ? 'The loop is between gates: the current stage run or the foreman dispatch is in flight.'
                  : `The item is ${workItem.status}; no gate is pending.`
              }
            />
          )}
        </CardBody>
      </Card>

      <Card testId="work-item-timeline-card">
        <CardHeader
          title="Stage timeline"
          hint="Every transition records from → to, who decided, and why."
        />
        <CardBody>
          {transitions.length === 0 ? (
            <EmptyState
              testId="work-item-timeline-empty"
              title="No stage transitions yet"
              description={`The item is still in ${workItem.stage}; the foreman has not advanced it.`}
            />
          ) : (
            <ol data-testid="work-item-timeline" className="space-y-2">
              {transitions.map((transition) => (
                <li
                  key={transition.id}
                  data-testid="timeline-row"
                  data-from={transition.from}
                  data-to={transition.to}
                  data-by={transition.by}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
                >
                  <span className="font-mono text-xs text-slate-500">{transition.from}</span>
                  <span aria-hidden="true" className="text-slate-400">
                    →
                  </span>
                  <span className="font-mono text-xs font-semibold text-slate-800">{transition.to}</span>
                  <span data-testid="timeline-by" className="text-xs text-slate-500">
                    by {transition.by}
                    {transition.actor && transition.actor !== transition.by
                      ? ` (${transition.actor})`
                      : ''}
                  </span>
                  {transition.reason ? (
                    <span data-testid="timeline-reason" className="text-xs text-slate-600">
                      — {transition.reason}
                    </span>
                  ) : null}
                  <span className="ml-auto text-[11px] text-slate-400">{formatDateTime(transition.at)}</span>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>

      <Card testId="work-item-gates-card">
        <CardHeader
          title="Gate decisions"
          hint="Approve, reject or request_changes — with actor and time."
        />
        {gates.length === 0 ? (
          <CardBody>
            <EmptyState testId="work-item-gates-empty" title="No gate decisions recorded yet" />
          </CardBody>
        ) : (
          <Table
            testId="work-item-gates"
            rowTestId="gate-decision-row"
            rows={gates}
            rowKey={(row: GateDecisionRecord) => `${row.stage}:${row.attempt}`}
            columns={[
              {
                header: 'Stage',
                cell: (row: GateDecisionRecord) => (
                  <span className="font-mono text-xs" data-testid="gate-decision-stage">
                    {row.stage} · #{row.attempt}
                  </span>
                ),
              },
              {
                header: 'Gate',
                cell: (row: GateDecisionRecord) => (
                  <Badge tone={row.gate === 'human' ? 'warning' : 'success'} mono>
                    {row.gate}
                  </Badge>
                ),
              },
              {
                header: 'Decision',
                cell: (row: GateDecisionRecord) => (
                  <span
                    data-testid="gate-decision-decision"
                    data-decision={row.decision ?? 'pending'}
                    data-automatic={row.automatic ? 'true' : 'false'}
                  >
                    <Badge
                      tone={
                        row.decision === null
                          ? 'info'
                          : row.decision === 'approve'
                            ? 'success'
                            : row.decision === 'reject'
                              ? 'danger'
                              : 'warning'
                      }
                    >
                      {row.decision ?? 'pending'}
                    </Badge>
                  </span>
                ),
              },
              {
                header: 'Actor',
                cell: (row: GateDecisionRecord) => (
                  <span data-testid="gate-decision-actor" className="font-mono text-xs text-slate-600">
                    {row.actor ?? '—'}
                    {row.automatic ? ' (automatic)' : ''}
                  </span>
                ),
              },
              {
                header: 'Reason / feedback',
                cell: (row: GateDecisionRecord) => (
                  <span data-testid="gate-decision-reason" className="text-xs text-slate-600">
                    {row.feedback ?? row.reason ?? '—'}
                  </span>
                ),
              },
              {
                header: 'Decided',
                cell: (row: GateDecisionRecord) => (
                  <span data-testid="gate-decision-time" className="text-xs text-slate-500">
                    {formatDateTime(row.decidedAt)}
                  </span>
                ),
              },
            ]}
          />
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card testId="work-item-review-card">
          <CardHeader
            title="Review committee"
            hint="Two independent reviewers and a judge. The verdict is advisory — it never merges."
          />
          <CardBody className="space-y-3">
            {reports.length === 0 ? (
              <EmptyState
                testId="work-item-review-empty"
                title="No reviewer reports yet"
                description="Reviewer reports appear after the review stage runs."
              />
            ) : (
              <ul data-testid="work-item-reviewers" className="space-y-2">
                {reports.map((report) => (
                  <li
                    key={`${report.reviewer}-${report.at ?? ''}`}
                    data-testid="reviewer-report"
                    data-reviewer={report.reviewer}
                    data-verdict={report.verdict}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  >
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-slate-800">
                        {report.reviewer}
                      </span>
                      <Badge tone={report.verdict === 'approve' ? 'success' : 'danger'}>
                        {report.verdict}
                      </Badge>
                      <span className="text-xs text-slate-500" data-testid="reviewer-confidence">
                        confidence {report.confidence ?? '—'}
                      </span>
                      {report.runId ? (
                        <Link
                          href={`/runs/${encodeURIComponent(report.runId)}`}
                          className="font-mono text-[11px] text-sky-700 underline decoration-sky-200 underline-offset-2"
                        >
                          run
                        </Link>
                      ) : null}
                    </p>
                    {report.findings.length === 0 ? (
                      <p className="mt-1 text-xs text-slate-500">No findings.</p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {report.findings.map((finding, index) => (
                          <li
                            key={`${finding.reviewer}-${index}`}
                            data-testid="reviewer-finding"
                            data-severity={finding.severity}
                            className="text-xs text-slate-600"
                          >
                            <span className="font-mono text-[11px] uppercase text-slate-500">
                              {finding.severity}
                            </span>{' '}
                            {finding.summary}
                            {finding.file ? (
                              <span className="font-mono text-[11px] text-slate-400"> · {finding.file}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {judge ? (
              <div
                data-testid="review-judge"
                data-verdict={judge.verdict}
                data-confidence={judge.confidence ?? ''}
                data-advisory={judge.advisory ? 'true' : 'false'}
                data-incomplete={judge.incomplete ? 'true' : 'false'}
                className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm"
              >
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-sky-800">Judge</span>
                  <Badge
                    tone={
                      judge.verdict === 'approve'
                        ? 'success'
                        : judge.verdict === 'reject'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {judge.verdict}
                  </Badge>
                  <span data-testid="judge-confidence" className="text-xs text-sky-900">
                    confidence {judge.confidence ?? '—'}
                  </span>
                  <span className="text-xs text-sky-900">
                    {judge.reviewers ?? '—'} reviewers
                  </span>
                  <span data-testid="judge-advisory" className="text-[11px] text-sky-800">
                    {judge.advisory ? 'advisory only' : 'not advisory'}
                  </span>
                </p>
                {judge.findings.length > 0 ? (
                  <ul className="mt-1 space-y-1">
                    {judge.findings.map((finding, index) => (
                      <li key={index} className="text-xs text-sky-900" data-testid="judge-finding">
                        <span className="font-mono text-[11px] uppercase">{finding.severity}</span>{' '}
                        {finding.summary}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-sky-800">No findings merged.</p>
                )}
              </div>
            ) : (
              <p data-testid="review-judge-empty" className="text-xs text-slate-500">
                No judge verdict recorded yet.
              </p>
            )}
          </CardBody>
        </Card>

        <div className="space-y-4">
          <Card testId="work-item-runs-card">
            <CardHeader title="Stage runs" hint="Each stage attempt is its own run, pinned to the commit." />
            <CardBody>
              {runs.length === 0 ? (
                <EmptyState testId="work-item-runs-empty" title="No runs recorded yet" />
              ) : (
                <ul data-testid="work-item-runs" className="space-y-1 text-sm">
                  {runs.map((run) => (
                    <li key={run.runId} className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/runs/${encodeURIComponent(run.runId)}`}
                        data-testid="work-item-run-link"
                        className="font-mono text-xs text-sky-700 underline decoration-sky-200 underline-offset-2"
                      >
                        {run.runId}
                      </Link>
                      <span className="text-xs text-slate-500">{run.label}</span>
                      <span className="ml-auto text-[11px] text-slate-400">{formatDateTime(run.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card testId="work-item-checks-card">
            <CardHeader title="Forge checks" hint="Verify reads checks through the forge; red stops the loop." />
            <CardBody>
              {checks ? (
                <div data-testid="work-item-checks" data-green={checks.green ? 'true' : 'false'} className="space-y-2">
                  <Badge tone={checks.green ? 'success' : 'danger'} testId="checks-green">
                    {checks.green ? 'green' : 'red'}
                  </Badge>
                  {checks.checks.length === 0 ? (
                    <p className="text-xs text-slate-500">No individual checks recorded.</p>
                  ) : (
                    <ul className="space-y-1">
                      {checks.checks.map((check, index) => (
                        <li key={index} className="font-mono text-[11px] text-slate-600">
                          {check.name ?? 'check'} · {check.conclusion ?? check.status ?? 'unknown'}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <p data-testid="work-item-checks-empty" className="text-sm text-slate-500">
                  No checks recorded yet.
                </p>
              )}
            </CardBody>
          </Card>

          <Card testId="work-item-status-card">
            <CardHeader title="Status events" hint="Blocked, escalated, done and merge evidence." />
            <CardBody>
              {statuses.length === 0 ? (
                <EmptyState testId="work-item-status-empty" title="No status changes recorded" />
              ) : (
                <ul data-testid="work-item-status-events" className="space-y-1 text-sm">
                  {statuses.map((entry, index) => (
                    <li
                      key={index}
                      data-testid="status-event"
                      data-status={entry.status}
                      data-reason={entry.reason ?? ''}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <Badge tone={statusTone(entry.status)}>{entry.status}</Badge>
                      <span className="text-xs text-slate-600">{entry.reason ?? '—'}</span>
                      <span className="ml-auto text-[11px] text-slate-400">{formatDateTime(entry.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
