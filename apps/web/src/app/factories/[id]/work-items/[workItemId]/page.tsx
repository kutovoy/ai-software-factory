import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { GateDecisionActions } from '@/components/work-items/GateDecisionActions';
import { GateVerdictBadge } from '@/components/work-items/GateVerdictBadge';
import { RetryWorkItemButton } from '@/components/work-items/RetryWorkItemButton';
import { SlaCountdown } from '@/components/work-items/SlaCountdown';
import { ApiClientError, apiGet } from '@/lib/api';
import { factoryNameOf, loadFactory } from '@/lib/factory-page';
import { formatDateTime, shortCommit, statusTone } from '@/lib/format';
import { TimeAgo } from '@/components/ui/TimeAgo';
import type {
  GateDecisionRecord,
  ReviewPacketWire,
  RiskTierWire,
  ValidationCheckResultWire,
  ValidationProjectionWire,
  WorkItemDetail,
} from '@/lib/types';
import {
  canRetryWorkItem,
  checksRecorded,
  judgeVerdict,
  lastAutonomyEvent,
  mergedAt,
  prOpened,
  retryEvents,
  reviewPacket,
  reviewerReports,
  runsForWorkItem,
  slaState,
  stageTimeline,
  statusEvents,
} from '@/lib/work-items';

export const dynamic = 'force-dynamic';

function riskTone(tier: RiskTierWire): 'success' | 'warning' | 'danger' {
  if (tier === 'low') return 'success';
  if (tier === 'medium') return 'warning';
  return 'danger';
}

function slopTone(status: 'pass' | 'exceeded' | 'unknown'): 'success' | 'danger' | 'neutral' {
  if (status === 'pass') return 'success';
  if (status === 'exceeded') return 'danger';
  return 'neutral';
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'];

/** True only for a path that really looks like an image; thumbnails are never invented. */
function isImagePath(path: string): boolean {
  const lower = path.toLowerCase().split(/[?#]/)[0] ?? '';
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Compact deterministic review packet (`review.packet`). It renders exactly what the event
 * carries — no invented intent, questions, checklist items, proof or decisions — and is
 * omitted entirely when the loop has not assembled a packet yet.
 *
 * Packet v2 (`add-anti-slop-budgets-and-proof`) adds slop budget vs actual, blast radius, a
 * proof gallery, read-first, decisions, reviewer roles, comprehension and the context-pack
 * ref. Each section renders only when the packet carries data for it.
 */
function ReviewPacketCard({ packet }: { packet: ReviewPacketWire | null }) {
  if (!packet) return null;
  const failing = packet.assertions.filter((assertion) => assertion.status !== 'pass');

  const budget = packet.slopBudget;
  const actual = packet.slopActual;
  const budgetMetrics =
    budget && actual
      ? [
          {
            key: 'maxDiffLines',
            label: 'diff lines',
            actual: actual.diffLines,
            limit: budget.maxDiffLines,
          },
          {
            key: 'maxChangedFiles',
            label: 'changed files',
            actual: actual.changedFiles,
            limit: budget.maxChangedFiles,
          },
          {
            key: 'maxNewDependencies',
            label: 'new dependencies',
            actual: actual.newDependencies,
            limit: budget.maxNewDependencies,
          },
          {
            key: 'maxDuplicationDeltaPercent',
            label: 'duplication delta %',
            actual: actual.duplicationDeltaPercent,
            limit: budget.maxDuplicationDeltaPercent,
          },
          {
            key: 'maxComplexityDelta',
            label: 'complexity delta',
            actual: actual.complexityDelta,
            limit: budget.maxComplexityDelta,
          },
        ]
      : [];
  const overages = budgetMetrics.filter(
    (metric) => metric.actual !== null && metric.actual > metric.limit,
  );

  const blast = packet.blastRadius;
  const blastHasData =
    blast !== undefined &&
    (blast.paths.length > 0 ||
      blast.highRiskPaths.length > 0 ||
      blast.publicApiChanges > 0 ||
      blast.schemaChanges > 0);
  const proof = packet.proofArtifacts ?? [];
  const readFirst = packet.readFirst ?? [];
  const decisions = packet.decisions ?? [];
  const roles = packet.reviewerRoles ?? [];
  const comprehension = packet.comprehension;

  return (
    <div data-testid="work-item-review-packet" data-risk-tier={packet.riskTier}>
      <Card>
        <CardHeader
          title="Review packet"
          hint="Deterministic summary assembled from the plan, evidence and diff; the full diff stays linked on the run."
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={riskTone(packet.riskTier)} testId="review-packet-risk">
                {packet.riskTier} risk
              </Badge>
              {packet.slopStatus ? (
                <span
                  data-testid="review-packet-slop"
                  data-slop-status={packet.slopStatus}
                  title="Slop budget status measured from the captured patch"
                >
                  <Badge tone={slopTone(packet.slopStatus)} mono>
                    slop {packet.slopStatus}
                  </Badge>
                </span>
              ) : null}
            </div>
          }
        />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span data-testid="review-packet-changed-files">
              changed files <span className="font-mono">{packet.changedFiles}</span>
            </span>
            <span data-testid="review-packet-diff">
              diff{' '}
              <span className="font-mono text-emerald-700">+{packet.diffStats.additions}</span>{' '}
              <span className="font-mono text-red-700">-{packet.diffStats.deletions}</span>
            </span>
            <span data-testid="review-packet-plan-ref">
              plan ref{' '}
              <span className="font-mono">{packet.planRef ?? 'none recorded'}</span>
            </span>
            {packet.riskTier === 'high' ? (
              <Badge tone="danger" testId="review-packet-human-required">
                human review required before ship
              </Badge>
            ) : null}
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Intent</p>
            <p data-testid="review-packet-intent" className="mt-1 text-sm text-slate-700">
              {packet.intent || 'No intent recorded in the packet.'}
            </p>
          </div>

          {budgetMetrics.length > 0 ? (
            <div data-testid="review-packet-budget" data-slop-status={packet.slopStatus ?? 'unknown'}>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Slop budget (actual / limit)
              </p>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
                {budgetMetrics.map((metric) => {
                  const over = metric.actual !== null && metric.actual > metric.limit;
                  return (
                    <span
                      key={metric.key}
                      data-metric={metric.key}
                      data-over={over ? 'true' : 'false'}
                      className={over ? 'text-red-700' : undefined}
                    >
                      {metric.label}{' '}
                      <span className="font-mono">
                        {metric.actual === null ? 'unknown' : metric.actual} / {metric.limit}
                      </span>
                    </span>
                  );
                })}
              </div>
              {overages.length > 0 ? (
                <p data-testid="review-packet-budget-overages" className="mt-1 text-xs text-red-700">
                  over budget: {overages.map((metric) => metric.label).join(', ')}
                </p>
              ) : null}
            </div>
          ) : null}

          {blastHasData && blast ? (
            <div data-testid="review-packet-blast-radius">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Blast radius
              </p>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
                <span>
                  paths <span className="font-mono">{blast.paths.length}</span>
                </span>
                <span className={blast.highRiskPaths.length > 0 ? 'text-amber-700' : undefined}>
                  high-risk paths <span className="font-mono">{blast.highRiskPaths.length}</span>
                </span>
                <span>
                  public API changes <span className="font-mono">{blast.publicApiChanges}</span>
                </span>
                <span>
                  schema changes <span className="font-mono">{blast.schemaChanges}</span>
                </span>
              </div>
              {blast.highRiskPaths.length > 0 ? (
                <ul
                  data-testid="review-packet-blast-radius-high-risk"
                  className="mt-1 space-y-0.5 font-mono text-[11px] text-amber-800"
                >
                  {blast.highRiskPaths.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              ) : null}
              {blast.paths.length > 0 ? (
                <ul
                  data-testid="review-packet-blast-radius-paths"
                  className="mt-1 space-y-0.5 font-mono text-[11px] text-slate-600"
                >
                  {blast.paths.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Assertions ({packet.assertions.length}
              {failing.length > 0 ? ` · ${failing.length} not passing` : ''})
            </p>
            {packet.assertions.length === 0 ? (
              <p data-testid="review-packet-assertions-empty" className="mt-1 text-xs text-slate-500">
                The packet carries no assertion evidence.
              </p>
            ) : (
              <ul data-testid="review-packet-assertions" className="mt-1 space-y-1">
                {packet.assertions.map((assertion) => (
                  <li
                    key={assertion.id || assertion.evidence}
                    data-testid="review-packet-assertion"
                    data-status={assertion.status}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs"
                  >
                    <Badge
                      tone={
                        assertion.status === 'pass'
                          ? 'success'
                          : assertion.status === 'fail'
                            ? 'danger'
                            : 'warning'
                      }
                      mono
                    >
                      {assertion.status}
                    </Badge>
                    <span className="font-mono text-[11px] text-slate-700">
                      {assertion.id || 'unnamed assertion'}
                    </span>
                    <span className="text-slate-600">{assertion.evidence || 'no evidence recorded'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {proof.length > 0 ? (
            <div data-testid="review-packet-proof">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Proof ({proof.length})
              </p>
              <ul className="mt-1 space-y-1">
                {proof.map((artifact) => (
                  <li
                    key={`${artifact.kind}:${artifact.path}`}
                    data-testid="review-packet-proof-artifact"
                    data-proof-kind={artifact.kind}
                    className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral" mono>
                        {artifact.kind}
                      </Badge>
                      <a
                        href={artifact.path}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="review-packet-proof-link"
                        className="font-mono text-[11px] text-sky-700 underline decoration-sky-200 underline-offset-2"
                      >
                        {artifact.label || artifact.path}
                      </a>
                      <span className="font-mono text-[11px] text-slate-500">{artifact.path}</span>
                      {artifact.hash ? (
                        <span className="font-mono text-[11px] text-slate-400" title={artifact.hash}>
                          sha {artifact.hash.slice(0, 12)}
                        </span>
                      ) : null}
                    </div>
                    {isImagePath(artifact.path) ? (
                      <img
                        src={artifact.path}
                        alt={artifact.label || artifact.path}
                        data-testid="review-packet-proof-thumbnail"
                        className="mt-1 max-h-40 rounded border border-slate-200"
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {readFirst.length > 0 ? (
            <div data-testid="review-packet-read-first">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Read first
              </p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-slate-700">
                {readFirst.map((entry, index) => (
                  <li key={`${entry.path}:${index}`} data-testid="review-packet-read-first-item">
                    <span className="font-mono text-[11px]">{entry.path}</span>
                    {entry.why ? <span className="text-slate-500"> — {entry.why}</span> : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {decisions.length > 0 ? (
            <div data-testid="review-packet-decisions">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Decisions
              </p>
              <ul className="mt-1 space-y-1 text-xs text-slate-700">
                {decisions.map((decision, index) => (
                  <li
                    key={`${decision.at}:${decision.actor}:${index}`}
                    data-testid="review-packet-decision"
                    className="flex flex-wrap items-center gap-2"
                  >
                    <Badge tone="neutral" mono>
                      {decision.decision || 'unknown'}
                    </Badge>
                    <span className="font-mono text-[11px] text-slate-600">
                      {decision.actor || 'unknown actor'}
                    </span>
                    {decision.reason ? <span className="text-slate-600">{decision.reason}</span> : null}
                    {decision.at ? (
                      <span className="text-[11px] text-slate-400">{formatDateTime(decision.at)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {roles.length > 0 ? (
            <div data-testid="review-packet-roles" className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Reviewer roles
              </p>
              {roles.map((role) => (
                <span key={role} data-testid="review-packet-role">
                  <Badge tone="info" mono>
                    {role}
                  </Badge>
                </span>
              ))}
            </div>
          ) : null}

          {comprehension ? (
            <div data-testid="review-packet-comprehension" className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
              <span>
                read time <span className="font-mono">{comprehension.estimatedReadMinutes} min</span>
              </span>
              <span>
                files without tests{' '}
                <span className="font-mono">{comprehension.filesWithoutTests}</span>
              </span>
              <span>
                modules without owner{' '}
                <span className="font-mono">{comprehension.modulesWithoutOwner}</span>
              </span>
            </div>
          ) : null}

          {packet.contextPackRef ? (
            <p data-testid="review-packet-context" className="text-xs text-slate-600">
              context pack <span className="font-mono text-[11px]">{packet.contextPackRef}</span>
            </p>
          ) : null}

          <div className="grid gap-3 md:grid-cols-3">
            <div data-testid="review-packet-architecture-impact">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Architecture impact
              </p>
              {packet.architectureImpact.length === 0 ? (
                <p className="mt-1 text-xs text-slate-500">No architecture impact recorded.</p>
              ) : (
                <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
                  {packet.architectureImpact.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
            <div data-testid="review-packet-open-questions">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Open questions
              </p>
              {packet.openQuestions.length === 0 ? (
                <p className="mt-1 text-xs text-slate-500">No open questions recorded.</p>
              ) : (
                <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
                  {packet.openQuestions.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              )}
            </div>
            <div data-testid="review-packet-checklist">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Reviewer checklist
              </p>
              {packet.reviewerChecklist.length === 0 ? (
                <p className="mt-1 text-xs text-slate-500">No checklist recorded.</p>
              ) : (
                <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
                  {packet.reviewerChecklist.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function validationStatusTone(
  status: ValidationCheckResultWire['status'],
): 'success' | 'danger' | 'warning' {
  if (status === 'pass') return 'success';
  if (status === 'fail') return 'danger';
  return 'warning';
}

function ValidationCard({ validation }: { validation: ValidationProjectionWire | null }) {
  if (!validation) {
    return (
      <Card testId="work-item-validation-card">
        <CardHeader
          title="Validation contract"
          hint="Acceptance checks, QA tiers and evidence recorded for this item."
        />
        <CardBody>
          <EmptyState
            testId="validation-empty"
            title="No validation contract on this item"
            description="The item carries no persisted contract (older definition, or validation disabled for this factory). Nothing is inferred here."
          />
        </CardBody>
      </Card>
    );
  }

  const { contract, checks, complete, missing } = validation;

  return (
    <Card testId="work-item-validation-card">
      <CardHeader
        title="Validation contract"
        hint="A machine-checkable contract: every check is pass, fail or missing against recorded evidence."
        action={
          <Badge tone={complete ? 'success' : 'warning'} testId="validation-complete">
            {complete ? 'complete' : 'incomplete'}
          </Badge>
        }
      />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <Badge tone={contract.enforce ? 'warning' : 'neutral'} testId="validation-enforce">
            enforce {contract.enforce ? 'on' : 'off'}
          </Badge>
          <span>
            source <span className="font-mono" data-testid="validation-source">{contract.source}</span>
          </span>
          <span>
            contract <span className="font-mono">{contract.version}</span>
          </span>
          <span>
            commit{' '}
            <span className="font-mono" data-testid="validation-commit">
              {shortCommit(contract.definitionCommit)}
            </span>
          </span>
          <TimeAgo value={contract.createdAt} prefix="created " testId="validation-created" />
        </div>

        {checks.length === 0 ? (
          <EmptyState
            testId="validation-checks-empty"
            title="The contract declares no checks"
            description="A contract with no checks cannot prove anything; nothing is reported as passing."
          />
        ) : (
          <Table
            testId="validation-checks"
            rowTestId="validation-check"
            rows={checks}
            rowKey={(row: ValidationCheckResultWire) => row.check.id}
            columns={[
              {
                header: 'Check',
                cell: (row: ValidationCheckResultWire) => (
                  <span className="text-xs font-medium text-slate-800" data-check-id={row.check.id}>
                    {row.check.title}
                  </span>
                ),
              },
              {
                header: 'Tier',
                cell: (row: ValidationCheckResultWire) => (
                  <Badge tone="neutral" mono>
                    {row.check.tier}
                  </Badge>
                ),
              },
              {
                header: 'Required',
                cell: (row: ValidationCheckResultWire) => (
                  <span className="text-xs text-slate-600">{row.check.required ? 'yes' : 'no'}</span>
                ),
              },
              {
                header: 'Status',
                cell: (row: ValidationCheckResultWire) => (
                  <span data-status={row.status}>
                    <Badge tone={validationStatusTone(row.status)} testId="validation-check-status" mono>
                      {row.status}
                    </Badge>
                  </span>
                ),
              },
              {
                header: 'Source',
                cell: (row: ValidationCheckResultWire) => (
                  <span className="font-mono text-[11px] text-slate-600" data-testid="validation-check-source">
                    {row.source ?? '—'}
                  </span>
                ),
              },
              {
                header: 'Evidence',
                cell: (row: ValidationCheckResultWire) => (
                  <div className="space-y-0.5">
                    <span className="font-mono text-[11px] text-slate-600" data-testid="validation-check-evidence">
                      {row.evidence?.detail ?? row.check.command ?? row.check.expected ?? '—'}
                    </span>
                    {row.check.thresholds && Object.keys(row.check.thresholds).length > 0 ? (
                      <p
                        data-testid="validation-check-thresholds"
                        className="font-mono text-[11px] text-slate-500"
                      >
                        thresholds:{' '}
                        {Object.entries(row.check.thresholds)
                          .map(([key, value]) => `${key}=${value}`)
                          .join(', ')}
                      </p>
                    ) : null}
                    {row.evidence?.metrics && Object.keys(row.evidence.metrics).length > 0 ? (
                      <p
                        data-testid="validation-check-metrics"
                        className="font-mono text-[11px] text-slate-500"
                      >
                        metrics:{' '}
                        {Object.entries(row.evidence.metrics)
                          .map(([key, value]) => `${key}=${value}`)
                          .join(', ')}
                      </p>
                    ) : null}
                  </div>
                ),
              },
            ]}
          />
        )}

        {!complete ? (
          <div
            data-testid="validation-missing"
            className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          >
            <span className="font-semibold">Missing required evidence:</span>{' '}
            <span className="font-mono">{missing.length > 0 ? missing.join(', ') : 'none listed'}</span>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

export default async function WorkItemDetailPage({
  params,
}: {
  params: Promise<{ id: string; workItemId: string }>;
}) {
  const { id, workItemId } = await params;
  const factoryId = decodeURIComponent(id);
  const encoded = encodeURIComponent(factoryId);
  const basePath = `/factories/${encoded}/work-items`;

  let detail: WorkItemDetail;
  try {
    detail = await apiGet<WorkItemDetail>(
      `/factories/${encoded}/work-items/${encodeURIComponent(workItemId)}`,
    );
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) notFound();
    throw error;
  }

  const factory = await loadFactory(factoryId);
  const factoryName = factoryNameOf(factory, factoryId);
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
  const retries = retryEvents(events);
  const packet = reviewPacket(events);
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
            {workItem.attempt && workItem.attempt > 1 ? (
              <Badge tone="info" testId="work-item-attempt">
                attempt {workItem.attempt}
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
        <div className="flex flex-col items-end gap-2">
          {/* Retry belongs to the work item: a factory stage run refuses per-run retry. */}
          {canRetryWorkItem(workItem.status) ? (
            <RetryWorkItemButton
              factoryId={factoryId}
              workItemId={workItem.id}
              status={workItem.status}
            />
          ) : null}
          <Link
            href={basePath}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Back to board
          </Link>
        </div>
      </header>

      <Card testId="work-item-meta">
        <CardBody className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Factory</p>
            <Link
              href={`/factories/${encoded}/dashboard`}
              className="font-mono text-sm text-slate-800 underline decoration-slate-300 underline-offset-2"
            >
              {factoryName}
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
            <p className="text-xs uppercase tracking-wide text-slate-400">Attempt</p>
            <p
              data-testid="work-item-attempt-value"
              className="text-sm text-slate-800"
              title={workItem.workflowId ?? undefined}
            >
              {workItem.attempt ?? 1}
              {workItem.retriedAt ? (
                <>
                  {' · retried '}
                  <TimeAgo value={workItem.retriedAt} />
                </>
              ) : null}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Created</p>
            <p data-testid="work-item-created" className="text-sm text-slate-800">
              <TimeAgo value={workItem.createdAt} />
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
          {workItem.input !== undefined ? (
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Context pack</p>
              {typeof workItem.input.contextPackRef === 'string' &&
              workItem.input.contextPackRef.trim() !== '' ? (
                <p
                  data-testid="work-item-context-pack"
                  className="break-all font-mono text-[11px] text-slate-600"
                >
                  {workItem.input.contextPackRef}
                </p>
              ) : (
                <p data-testid="work-item-context-pack-empty" className="text-sm text-slate-500">
                  none recorded
                </p>
              )}
            </div>
          ) : null}
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
                  href={`${basePath}/${encodeURIComponent(workItem.parentId)}`}
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

      <ReviewPacketCard packet={packet} />

      <ValidationCard validation={detail.validation} />

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
              No autonomy change is recorded for this item. The factory-level state (declared policy,
              enabled/paused, newest event) is projected by the Gates page from{' '}
              <span className="font-mono">GET /autonomy</span>; this panel shows only what the item's
              event log proves.
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
                  waiting <TimeAgo value={pendingGate.requestedAt} />
                </span>
                <SlaCountdown slaAt={pendingGate.slaAt} testId="work-item-pending-gate-sla" />
              </div>
              {pendingGate.verdict ? (
                <GateVerdictBadge
                  verdict={pendingGate.verdict}
                  testId="work-item-pending-gate-verdict"
                />
              ) : null}
              <GateDecisionActions
                factoryId={factoryId}
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
                header: 'Verdict',
                cell: (row: GateDecisionRecord) =>
                  row.verdict ? (
                    <GateVerdictBadge verdict={row.verdict} />
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
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
                          href={`/factories/${encoded}/runs/${encodeURIComponent(report.runId)}`}
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
                        href={`/factories/${encoded}/runs/${encodeURIComponent(run.runId)}`}
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
            <CardHeader title="Status events" hint="Blocked, escalated, done, merge evidence and retries." />
            <CardBody className="space-y-3">
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
              {retries.length > 0 ? (
                <div data-testid="work-item-retried-events" className="space-y-1 border-t border-slate-200 pt-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Retries</p>
                  <ul className="space-y-1 text-sm">
                    {retries.map((retry, index) => (
                      <li
                        key={index}
                        data-testid="retried-event"
                        data-previous-status={retry.previousStatus ?? ''}
                        data-attempt={retry.attempt ?? ''}
                        data-actor={retry.actor ?? ''}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <Badge tone="info">attempt {retry.attempt ?? '—'}</Badge>
                        <span className="text-xs text-slate-600">
                          from {retry.previousStatus ?? 'unknown'}
                          {retry.actor ? ` · by ${retry.actor}` : ''}
                          {retry.reason ? ` — ${retry.reason}` : ''}
                        </span>
                        <span className="ml-auto text-[11px] text-slate-400">
                          {formatDateTime(retry.at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
