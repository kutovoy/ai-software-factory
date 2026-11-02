import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { CancelRunButton } from '@/components/runs/CancelRunButton';
import { CopyButton } from '@/components/runs/CopyButton';
import { FailurePanel } from '@/components/runs/FailurePanel';
import { RetryRunButton } from '@/components/runs/RetryRunButton';
import { RunLive } from '@/components/stream/RunLive';
import { ApiClientError, apiGet, safeGet } from '@/lib/api';
import { formatCost, formatDateTime, formatTokens, statusTone } from '@/lib/format';
import { ElapsedTime } from '@/components/ui/TimeAgo';
import { shortSha } from '@/lib/failure';
import type { RunArtifact, RunDetail, RunStep, ScoresResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Cancel is offered only while a cancel can still change the outcome. */
const LIVE = new Set(['pending', 'running', 'cancelling']);

export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; runId: string }>;
  searchParams: Promise<{ focus?: string }>;
}) {
  const { id, runId } = await params;
  const { focus } = await searchParams;
  const factoryId = decodeURIComponent(id);
  const encoded = encodeURIComponent(factoryId);

  let detail: RunDetail;
  try {
    detail = await apiGet<RunDetail>(
      `/factories/${encoded}/runs/${encodeURIComponent(runId)}`,
    );
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) notFound();
    throw error;
  }

  const scores = await safeGet<ScoresResponse>(
    `/factories/${encoded}/scores?run=${encodeURIComponent(runId)}&limit=50`,
    { scores: [], aggregate: [] },
  );

  const { run, summary, steps, artifacts, permissions } = detail;
  const artifactList = (artifacts ?? []) as RunArtifact[];
  const runInput = run.input as { prompt?: { text?: string; files?: string[] } } | null;
  const promptText = runInput?.prompt?.text ?? null;
  const promptFiles = runInput?.prompt?.files ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-slate-900">{run.title ?? run.id}</h1>
            <Badge tone={statusTone(run.status)} testId="run-detail-status">
              {run.status}
            </Badge>
            <Badge tone="neutral">{run.kind}</Badge>
          </div>
          <p className="font-mono text-xs text-slate-500" data-testid="run-id">
            {run.id}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Cancel only while it can do something; a terminal run shows its end state. */}
          {LIVE.has(run.status) ? (
            <CancelRunButton factoryId={factoryId} runId={run.id} />
          ) : (
            <span
              data-testid="run-terminal-state"
              data-status={run.status}
              className="text-sm text-slate-500"
            >
              Run ended · {run.status}
            </span>
          )}
          {run.kind === 'chat' && (run.status === 'error' || run.status === 'cancelled') ? (
            <RetryRunButton factoryId={factoryId} runId={run.id} />
          ) : null}
          {/* Factory stage runs belong to their work item: retry lives there, not per run. */}
          {run.kind === 'run' && summary.workItemId ? (
            <Link
              href={`/factories/${encoded}/work-items/${encodeURIComponent(summary.workItemId)}`}
              data-testid="run-retry-work-item"
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Retry the work item
            </Link>
          ) : null}
        </div>
      </header>

      {promptText ? (
        <Card testId="run-task">
          <CardHeader
            title="Task"
            hint="The prompt this run was started with — what the agent is working on."
          />
          <CardBody className="space-y-2">
            <p
              data-testid="run-prompt"
              className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800"
            >
              {promptText}
            </p>
            {promptFiles.length > 0 ? (
              <p data-testid="run-prompt-files" className="text-xs text-slate-500">
                files: <span className="font-mono">{promptFiles.join(', ')}</span>
              </p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <Card testId="run-meta">
        <CardBody className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <div className="min-w-0" data-testid="run-meta-cell" data-meta="factory">
            <p className="text-xs uppercase tracking-wide text-slate-400">Factory</p>
            <Link
              href={`/factories/${encoded}/dashboard`}
              title={run.factory}
              className="block truncate font-mono text-sm text-slate-800 underline decoration-slate-300 underline-offset-2"
            >
              {run.factory}
            </Link>
          </div>
          <div className="min-w-0" data-testid="run-meta-cell" data-meta="commit">
            <p className="text-xs uppercase tracking-wide text-slate-400">Pinned commit</p>
            <div className="flex items-center gap-2">
              {/* A 40-char SHA overflowed its column into the harness/model cell: the cell
                  shows the 12-char short form, the full value lives in `title` and the
                  copy affordance (and in an sr-only span for screen readers/tests). */}
              <span
                data-testid="pinned-commit"
                title={summary.definitionCommit}
                className="min-w-0 truncate font-mono text-sm text-slate-800"
              >
                {shortSha(summary.definitionCommit)}
                <span className="sr-only">{summary.definitionCommit}</span>
                {summary.definitionDirty ? ' (dirty)' : ''}
              </span>
              <CopyButton value={summary.definitionCommit} testId="pinned-commit-copy" />
            </div>
          </div>
          <div className="min-w-0" data-testid="run-meta-cell" data-meta="harness">
            <p className="text-xs uppercase tracking-wide text-slate-400">Harness / model</p>
            <p className="truncate font-mono text-sm text-slate-800" title={`${run.harness} · ${run.model ?? '—'}`}>
              <span data-testid="run-harness">{run.harness}</span>
              {' · '}
              <span data-testid="run-model">{run.model ?? '—'}</span>
            </p>
          </div>
          <div className="min-w-0" data-testid="run-meta-cell" data-meta="runner">
            <p className="text-xs uppercase tracking-wide text-slate-400">Runner</p>
            <p className="truncate font-mono text-sm text-slate-800" data-testid="run-runner" title={run.runner}>
              {run.runner}
            </p>
          </div>
          <div className="min-w-0" data-testid="run-meta-cell" data-meta="started">
            <p className="text-xs uppercase tracking-wide text-slate-400">Started</p>
            <p className="truncate text-sm text-slate-800" data-testid="run-started">
              {formatDateTime(summary.startedAt)}
            </p>
          </div>
          <div className="min-w-0" data-testid="run-meta-cell" data-meta="duration">
            <p className="text-xs uppercase tracking-wide text-slate-400">Duration</p>
            <p className="truncate text-sm text-slate-800" data-testid="run-duration">
              <ElapsedTime startedAt={summary.startedAt} endedAt={summary.endedAt} />
            </p>
          </div>
          <div className="min-w-0" data-testid="run-meta-cell" data-meta="cost">
            <p className="text-xs uppercase tracking-wide text-slate-400">Cost</p>
            <p className="truncate text-sm text-slate-800" data-testid="run-cost">
              {formatCost(summary.costUsd)}
            </p>
          </div>
          <div className="min-w-0" data-testid="run-meta-cell" data-meta="tokens">
            <p className="text-xs uppercase tracking-wide text-slate-400">Tokens</p>
            <p className="truncate text-sm text-slate-800" data-testid="run-tokens">
              in {formatTokens(summary.inputTokens)} · out {formatTokens(summary.outputTokens)}
            </p>
          </div>
        </CardBody>
      </Card>

      <FailurePanel factoryId={factoryId} run={run} steps={steps} summary={run.summary} />

      {detail.retryOf || detail.retriedBy ? (
        <Card testId="run-retry-lineage">
          <CardBody className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            {detail.retryOf ? (
              <p className="text-slate-700">
                Retried from{' '}
                <Link
                  href={`/factories/${encoded}/runs/${encodeURIComponent(detail.retryOf)}`}
                  className="font-mono underline decoration-slate-300 underline-offset-2"
                  data-testid="run-retried-from"
                >
                  {detail.retryOf}
                </Link>
              </p>
            ) : null}
            {detail.retriedBy ? (
              <p className="text-slate-700">
                Retried as{' '}
                <Link
                  href={`/factories/${encoded}/runs/${encodeURIComponent(detail.retriedBy)}`}
                  className="font-mono underline decoration-slate-300 underline-offset-2"
                  data-testid="run-retried-by"
                >
                  {detail.retriedBy}
                </Link>
              </p>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      <Card testId="run-scores-card">
        <CardHeader
          title="Scores"
          hint="Deterministic checks and sampled judge scores attached to this run."
          action={
            <Badge tone="neutral" testId="run-scores-count">
              {scores.scores.length}
            </Badge>
          }
        />
        {scores.scores.length === 0 ? (
          <CardBody>
            <EmptyState
              testId="run-scores-empty"
              title="No scores for this run yet"
              description="Scoring runs after the run reaches a terminal state. On-demand scoring is available via POST /api/v1/factories/:factoryId/scoring."
            />
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table data-testid="run-scores" className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  {['Scorer', 'Class', 'Status', 'Label', 'Score', 'Passing', 'Cost', ''].map((header) => (
                    <th key={header} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {scores.scores.map((score) => (
                  <tr key={score.id} data-testid="run-score-row" data-scorer={score.scorer}>
                    <td className="px-4 py-2 font-medium text-slate-900">{score.scorer}</td>
                    <td className="px-4 py-2">
                      <Badge tone={score.scorerClass === 'deterministic' ? 'info' : 'neutral'}>
                        {score.scorerClass}
                      </Badge>
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone={score.status === 'ok' ? 'success' : score.status === 'skipped' ? 'warning' : 'danger'}>
                        {score.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-800" data-testid="run-score-label">
                      {score.label ?? score.errorCode ?? '—'}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-800">
                      {score.score ?? '—'}
                    </td>
                    <td className="px-4 py-2">
                      {score.status === 'ok' ? (
                        <Badge tone={score.passing ? 'success' : 'danger'}>
                          {score.passing ? 'pass' : 'fail'}
                        </Badge>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-700">
                      {formatCost(score.provenance.costUsd)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        href={`/factories/${encoded}/scores/${encodeURIComponent(score.id)}`}
                        data-testid="run-score-link"
                        className="text-xs font-medium text-slate-700 underline decoration-slate-300 underline-offset-2"
                      >
                        Detail
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card testId="run-steps-card" className="min-w-0">
          <CardHeader title="Steps" hint="Runner lease, harness session and the event pump." />
          <Table
            testId="run-steps"
            rowTestId="run-step"
            rows={steps}
            rowKey={(step: RunStep) => step.step_id}
            empty={<CardBody><EmptyState testId="run-steps-empty" title="No steps recorded yet" /></CardBody>}
            columns={[
              {
                header: 'Step',
                cell: (step: RunStep) => (
                  <span className="font-mono text-xs text-slate-800">{step.step_id}</span>
                ),
              },
              {
                header: 'Kind',
                cell: (step: RunStep) => (
                  <span className="text-xs text-slate-600">{step.kind}</span>
                ),
              },
              {
                header: 'Status',
                cell: (step: RunStep) => (
                  <Badge tone={statusTone(step.status)}>{step.status}</Badge>
                ),
              },
              {
                header: 'Ended',
                cell: (step: RunStep) => (
                  <span className="text-xs text-slate-500">
                    {step.ended_at ? formatDateTime(step.ended_at) : '—'}
                  </span>
                ),
              },
            ]}
          />
        </Card>

        <Card testId="run-artifacts-card" className="min-w-0">
          <CardHeader title="Artifacts" hint="Patches, logs and screenshots captured by the runner." />
          {artifactList.length === 0 ? (
            <CardBody>
              <EmptyState testId="run-artifacts-empty" title="No artifacts for this run" />
            </CardBody>
          ) : (
            <CardBody>
              <ul data-testid="run-artifacts" className="space-y-1 text-sm">
                {artifactList.map((artifact, index) => (
                  <li
                    key={`${artifact.path ?? index}`}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="font-mono text-xs text-slate-700">
                      {typeof artifact === 'string' ? artifact : artifact.path}
                    </span>
                    {typeof artifact === 'object' && artifact.bytes !== undefined ? (
                      <span className="text-xs text-slate-400">{artifact.bytes} bytes</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          )}
        </Card>
      </div>

      <Card testId="run-events-card">
        <CardHeader
          title="Event stream"
          hint="Replayed from the persisted log, then tailed live — the same renderer New Chat uses."
        />
        <RunLive
          factoryId={factoryId}
          runId={run.id}
          initialStatus={run.status}
          permissions={permissions}
          focus={focus}
        />
      </Card>
    </div>
  );
}
