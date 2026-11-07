import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { TimeAgo } from '@/components/ui/TimeAgo';
import { MissionControls } from '@/components/missions/MissionControls';
import { MissionPlanDecisionActions } from '@/components/missions/MissionPlanDecisionActions';
import { RetryMissionFeature } from '@/components/missions/RetryMissionFeature';
import { ApiClientError, apiGet } from '@/lib/api';
import { factoryNameOf, loadFactory } from '@/lib/factory-page';
import { formatCost, formatDateTime, shortCommit } from '@/lib/format';
import {
  eventSummary,
  featureStatusTone,
  milestoneStatusTone,
  missionProgress,
  missionStatusTone,
  shortMissionId,
  validationStatusTone,
} from '@/lib/missions';
import type {
  MissionBudgetUsage,
  MissionDetail,
  MissionFeature,
  MissionGate,
  MissionMilestone,
  MissionMilestoneStatusWire,
  MissionPlanMilestoneWire,
  MissionSummary,
  MissionValidationAssertionWire,
  WorkItemSummary,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

/** A compact `key=value` line for checkpoint state / validation evidence records. */
function compactRecord(record: Record<string, unknown> | null | undefined): string {
  if (!record) return '';
  const entries = Object.entries(record).filter(
    ([, value]) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
  );
  if (entries.length === 0) return '';
  return entries
    .slice(0, 5)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' · ');
}

function findingLine(finding: Record<string, unknown>): string {
  const severity = typeof finding.severity === 'string' ? finding.severity : null;
  const summary =
    typeof finding.summary === 'string'
      ? finding.summary
      : typeof finding.message === 'string'
        ? finding.message
        : compactRecord(finding);
  const file = typeof finding.file === 'string' ? finding.file : null;
  return [severity ? `[${severity}]` : '', summary, file ? `· ${file}` : '']
    .filter(Boolean)
    .join(' ')
    .trim();
}

function PlanCard({ mission }: { mission: MissionSummary }) {
  const plan = mission.plan ?? null;
  if (!plan) {
    return (
      <Card testId="mission-plan-card">
        <CardHeader
          title="Plan and validation contract"
          hint="The planner writes the contract before features exist; nothing is inferred here."
        />
        <CardBody>
          <EmptyState
            testId="mission-plan-empty"
            title="No plan yet"
            description="The mission is planning, or the planner has not proposed a plan. Refresh once the plan gate appears."
          />
        </CardBody>
      </Card>
    );
  }

  const contract = plan.validationContract;

  return (
    <Card testId="mission-plan-card">
      <CardHeader
        title="Plan and validation contract"
        hint="The plan is pinned to the mission's definition commit; the contract states what proof is required."
        action={
          <Badge tone="neutral" testId="mission-plan-version">
            plan v{mission.planVersion}
          </Badge>
        }
      />
      <CardBody className="space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Goal</p>
          <p data-testid="mission-plan-goal" className="mt-1 text-sm text-slate-700">
            {plan.goal || mission.goal}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <Badge tone={contract.enforce ? 'warning' : 'neutral'} testId="mission-contract-enforce">
            enforce {contract.enforce ? 'on' : 'off'}
          </Badge>
          <span>
            contract{' '}
            <span className="font-mono" data-testid="mission-contract-version">
              {contract.version}
            </span>
          </span>
          <span>
            source{' '}
            <span className="font-mono" data-testid="mission-contract-source">
              {contract.source}
            </span>
          </span>
          <span>
            commit{' '}
            <span className="font-mono">{shortCommit(contract.definitionCommit)}</span>
          </span>
          <TimeAgo value={contract.createdAt} prefix="created " testId="mission-contract-created" />
        </div>

        {contract.assertions.length === 0 ? (
          <EmptyState
            testId="mission-contract-assertions-empty"
            title="The contract declares no assertions"
            description="A contract with no behavioral assertions cannot prove the goal; the plan gate should not approve it."
          />
        ) : (
          <Table
            testId="mission-contract-assertions"
            rowTestId="mission-assertion"
            rows={contract.assertions}
            rowKey={(assertion: MissionValidationAssertionWire) => assertion.id}
            columns={[
              {
                header: 'Assertion',
                cell: (assertion: MissionValidationAssertionWire) => (
                  <div className="space-y-0.5">
                    <p className="text-xs font-medium text-slate-800" data-testid="mission-assertion-title">
                      {assertion.title}
                    </p>
                    <p className="text-xs text-slate-600">{assertion.assertion}</p>
                    <p className="font-mono text-[11px] text-slate-400">{assertion.id}</p>
                  </div>
                ),
              },
              {
                header: 'Tier',
                cell: (assertion: MissionValidationAssertionWire) => (
                  <Badge tone="neutral" mono>
                    {assertion.tier}
                  </Badge>
                ),
              },
              {
                header: 'Required',
                cell: (assertion: MissionValidationAssertionWire) => (
                  <span className="text-xs text-slate-600">{assertion.required ? 'yes' : 'no'}</span>
                ),
              },
              {
                header: 'Tool',
                cell: (assertion: MissionValidationAssertionWire) => (
                  <span className="font-mono text-[11px] text-slate-600" data-testid="mission-assertion-tool">
                    {assertion.tool}
                  </span>
                ),
              },
              {
                header: 'Evidence',
                cell: (assertion: MissionValidationAssertionWire) => (
                  <div className="space-y-0.5">
                    <p className="font-mono text-[11px] text-slate-600" data-testid="mission-assertion-evidence">
                      {assertion.evidence}
                    </p>
                    {assertion.expected ? (
                      <p className="text-[11px] text-slate-500">expected: {assertion.expected}</p>
                    ) : null}
                    {assertion.command ? (
                      <p className="font-mono text-[11px] text-slate-400">{assertion.command}</p>
                    ) : null}
                  </div>
                ),
              },
            ]}
          />
        )}

        {plan.risks.length > 0 || plan.assumptions.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {plan.risks.length > 0 ? (
              <div data-testid="mission-plan-risks" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">Risks</p>
                <ul className="mt-1 space-y-0.5 text-xs text-amber-900">
                  {plan.risks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {plan.assumptions.length > 0 ? (
              <div data-testid="mission-plan-assumptions" className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Assumptions</p>
                <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
                  {plan.assumptions.map((assumption) => (
                    <li key={assumption}>{assumption}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function FeatureRows({
  factoryId,
  missionId,
  milestone,
  features,
  featureTitleById,
}: {
  factoryId: string;
  missionId: string;
  milestone: MissionMilestone;
  features: MissionFeature[];
  featureTitleById: Map<string, string>;
}) {
  const encoded = encodeURIComponent(factoryId);
  const ordered = [...features].sort((a, b) => a.ordinal - b.ordinal);

  if (ordered.length === 0) {
    return (
      <p data-testid="mission-milestone-features-empty" className="text-xs text-slate-500">
        No features are recorded for this milestone.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {ordered.map((feature) => (
        <li
          key={feature.id}
          data-testid="mission-feature"
          data-feature-id={feature.id}
          data-status={feature.status}
          className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={featureStatusTone(feature.status)} testId="mission-feature-status">
              {feature.status}
            </Badge>
            <span className="text-sm font-medium text-slate-800">{feature.title}</span>
            <span className="font-mono text-[11px] text-slate-400">
              #{feature.ordinal} · {feature.id}
            </span>
            {feature.attempt > 1 ? (
              <Badge tone="info" testId="mission-feature-attempt">
                attempt {feature.attempt}
              </Badge>
            ) : null}
            {feature.fixForFeatureId ? (
              <Badge tone="warning" testId="mission-feature-fix">
                fix for {shortMissionId(feature.fixForFeatureId)}
              </Badge>
            ) : null}
          </div>

          {feature.description ? (
            <p className="mt-1 text-xs text-slate-600">{feature.description}</p>
          ) : null}

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
            {feature.dependsOn.length > 0 ? (
              <span data-testid="mission-feature-depends-on">
                depends on{' '}
                <span className="font-mono">
                  {feature.dependsOn
                    .map((depId) => featureTitleById.get(depId) ?? shortMissionId(depId))
                    .join(', ')}
                </span>
              </span>
            ) : (
              <span data-testid="mission-feature-depends-on">no dependencies</span>
            )}
            {feature.acceptanceCheckIds.length > 0 ? (
              <span data-testid="mission-feature-assertions">
                assertions{' '}
                <span className="font-mono">{feature.acceptanceCheckIds.join(', ')}</span>
              </span>
            ) : null}
            {feature.workItemId ? (
              <Link
                href={`/factories/${encoded}/work-items/${encodeURIComponent(feature.workItemId)}`}
                data-testid="mission-feature-work-item"
                className="font-mono text-sky-700 underline decoration-sky-200 underline-offset-2"
              >
                work item {feature.workItemId}
              </Link>
            ) : (
              <span data-testid="mission-feature-work-item-empty">no work item yet</span>
            )}
          </div>

          {feature.status === 'failed' ? (
            <RetryMissionFeature
              factoryId={factoryId}
              missionId={missionId}
              featureId={feature.id}
              featureTitle={feature.title}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function PlanPreview({ milestones }: { milestones: MissionPlanMilestoneWire[] }) {
  const ordered = [...milestones].sort((a, b) => a.order - b.order);
  return (
    <div data-testid="mission-plan-preview" className="space-y-3">
      <p className="text-xs text-slate-500">
        The plan is proposed but not yet materialized into mission rows; this is the planner's
        decomposition, waiting for approval.
      </p>
      {ordered.map((milestone) => (
        <div key={milestone.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">planned</Badge>
            <span className="text-sm font-medium text-slate-800">{milestone.title}</span>
            <span className="font-mono text-[11px] text-slate-400">
              #{milestone.order} · {milestone.id}
            </span>
          </div>
          {milestone.description ? (
            <p className="mt-1 text-xs text-slate-600">{milestone.description}</p>
          ) : null}
          <ul className="mt-2 space-y-1">
            {[...milestone.features]
              .sort((a, b) => a.order - b.order)
              .map((feature) => (
                <li key={feature.id} data-testid="mission-plan-preview-feature" className="text-xs text-slate-600">
                  <span className="font-mono text-[11px] text-slate-400">#{feature.order}</span>{' '}
                  <span className="font-medium text-slate-800">{feature.title}</span>
                  {feature.dependsOn.length > 0 ? (
                    <span className="font-mono text-[11px] text-slate-400">
                      {' '}
                      · depends on {feature.dependsOn.join(', ')}
                    </span>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function BudgetCard({
  mission,
  usage,
}: {
  mission: MissionSummary;
  usage: MissionBudgetUsage | null;
}) {
  const budget = usage?.budget ?? mission.budget ?? {};
  const spend = usage?.spendUsd ?? mission.spendUsd ?? 0;
  const runs = usage?.runs ?? null;
  const wallClockHours = usage?.wallClockHours ?? null;
  const exhausted = usage?.exhausted === true;

  return (
    <Card testId="mission-budget-card">
      <CardHeader
        title="Budget"
        hint="Mission caps apply on top of the factory budget; an exhausted cap blocks new feature and validation runs."
        action={
          <Badge tone={exhausted ? 'danger' : 'neutral'} testId="mission-budget-state">
            {exhausted ? 'exhausted' : 'within caps'}
          </Badge>
        }
      />
      <CardBody className="grid grid-cols-2 gap-4 text-sm md:grid-cols-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Spend</p>
          <p data-testid="mission-budget-spend" className="font-mono text-sm text-slate-800">
            {formatCost(spend)}
            <span className="text-slate-400">
              {' / '}
              {budget.maxCostUsd === undefined ? 'no cap' : formatCost(budget.maxCostUsd)}
            </span>
          </p>
          {usage?.costExhausted ? (
            <p className="text-[11px] text-red-700">cost cap reached</p>
          ) : null}
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Runs</p>
          <p data-testid="mission-budget-runs" className="font-mono text-sm text-slate-800">
            {runs ?? '—'}
            <span className="text-slate-400">
              {' / '}
              {budget.maxRuns === undefined ? 'no cap' : budget.maxRuns}
            </span>
          </p>
          {usage?.runsExhausted ? (
            <p className="text-[11px] text-red-700">run cap reached</p>
          ) : null}
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">Wall clock</p>
          <p data-testid="mission-budget-wall-clock" className="font-mono text-sm text-slate-800">
            {wallClockHours === null ? '—' : `${wallClockHours}h`}
            <span className="text-slate-400">
              {' / '}
              {budget.maxWallClockHours === undefined ? 'no cap' : `${budget.maxWallClockHours}h`}
            </span>
          </p>
          {usage?.wallClockExhausted ? (
            <p className="text-[11px] text-red-700">wall-clock cap reached</p>
          ) : null}
        </div>
        {usage?.startedAt ? (
          <div className="md:col-span-3">
            <p className="text-xs uppercase tracking-wide text-slate-400">Mission started</p>
            <p className="text-sm text-slate-800">
              <TimeAgo value={usage.startedAt} testId="mission-budget-started" />
            </p>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}

export default async function MissionDetailPage({
  params,
}: {
  params: Promise<{ id: string; missionId: string }>;
}) {
  const { id, missionId } = await params;
  const factoryId = decodeURIComponent(id);
  const encoded = encodeURIComponent(factoryId);
  const basePath = `/factories/${encoded}/missions`;

  let detail: MissionDetail;
  try {
    detail = await apiGet<MissionDetail>(
      `/factories/${encoded}/missions/${encodeURIComponent(missionId)}`,
    );
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) notFound();
    throw error;
  }

  const factory = await loadFactory(factoryId);
  const factoryName = factoryNameOf(factory, factoryId);
  const { mission, milestones, features, checkpoints, events, validations, gates, pendingGate, workItems, budgetUsage } =
    detail;

  const progress = missionProgress(mission);
  const featureTitleById = new Map(features.map((feature) => [feature.id, feature.title]));
  const orderedMilestones = [...milestones].sort((a, b) => a.ordinal - b.ordinal);
  const orderedEvents = [...events].sort((a, b) => b.id - a.id);
  const orderedCheckpoints = [...checkpoints].sort((a, b) => b.seq - a.seq);
  const orderedValidations = [...validations].sort((a, b) => b.round - a.round);
  const pendingPlanGate =
    pendingGate ?? gates.find((gate) => gate.decision === null) ?? null;
  const planMilestones = mission.plan?.milestones ?? [];

  return (
    <div
      data-testid="mission-detail"
      data-mission-id={mission.id}
      data-status={mission.status}
      className="mx-auto max-w-6xl space-y-4 px-6 py-6"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 data-testid="mission-title" className="text-lg font-semibold text-slate-900">
              {mission.title}
            </h1>
            <Badge tone={missionStatusTone(mission.status)} testId="mission-status">
              {mission.status.replace(/_/g, ' ')}
            </Badge>
            <Badge tone="neutral" testId="mission-plan-version-badge">
              plan v{mission.planVersion}
            </Badge>
            {mission.workflowId ? (
              <Badge tone="neutral" mono testId="mission-workflow">
                {mission.workflowId}
              </Badge>
            ) : null}
          </div>
          <p className="font-mono text-xs text-slate-500" data-testid="mission-id">
            {mission.id}
          </p>
          <p className="text-sm text-slate-600" data-testid="mission-goal">
            {mission.goal}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Link
            href={basePath}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Back to missions
          </Link>
        </div>
      </header>

      {mission.error ? (
        <div
          data-testid="mission-error"
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          <span className="font-semibold">Blocked:</span>{' '}
          <span className="font-mono">{mission.error}</span>
        </div>
      ) : null}

      <Card testId="mission-meta">
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
            <p data-testid="mission-commit" className="font-mono text-sm text-slate-800">
              {shortCommit(mission.definitionCommit)}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Progress</p>
            <p data-testid="mission-progress" className="font-mono text-sm text-slate-800">
              {progress.label} features
              {progress.failed > 0 ? ` · ${progress.failed} failed` : ''}
            </p>
            <div className="mt-1 h-1.5 w-32 overflow-hidden rounded-full bg-slate-200">
              <div
                data-testid="mission-progress-bar"
                data-percent={progress.percent}
                className="h-full rounded-full bg-sky-600"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Milestones</p>
            <p data-testid="mission-milestones-progress" className="font-mono text-sm text-slate-800">
              {mission.milestoneDone ?? 0}/{mission.milestoneTotal ?? 0}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Current milestone</p>
            <p data-testid="mission-current-milestone" className="font-mono text-sm text-slate-800">
              {shortMissionId(mission.currentMilestoneId)}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Current feature</p>
            <p data-testid="mission-current-feature" className="font-mono text-sm text-slate-800">
              {shortMissionId(mission.currentFeatureId)}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Created</p>
            <p className="text-sm text-slate-800">
              <TimeAgo value={mission.createdAt} testId="mission-created" />
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Updated</p>
            <p className="text-sm text-slate-800">
              <TimeAgo value={mission.updatedAt} testId="mission-updated" />
            </p>
          </div>
        </CardBody>
      </Card>

      <Card testId="mission-controls-card">
        <CardHeader
          title="Controls"
          hint="Pause stops new dispatch; resume restarts it; cancel is terminal and needs a reason."
        />
        <CardBody>
          <MissionControls factoryId={factoryId} missionId={mission.id} status={mission.status} />
        </CardBody>
      </Card>

      <Card testId="mission-plan-gate-card">
        <CardHeader
          title="Plan approval"
          hint="The plan gate is a durable wait; approve it to dispatch features, or send the plan back with feedback."
        />
        <CardBody>
          {pendingPlanGate ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="warning" testId="mission-pending-plan-gate">
                  {pendingPlanGate.gate} gate · attempt {pendingPlanGate.attempt}
                </Badge>
                <span className="text-xs text-slate-500" data-testid="mission-pending-plan-age">
                  waiting <TimeAgo value={pendingPlanGate.requestedAt} />
                </span>
                {pendingPlanGate.slaAt ? (
                  <span className="font-mono text-[11px] text-slate-500">
                    SLA {formatDateTime(pendingPlanGate.slaAt)}
                  </span>
                ) : null}
              </div>
              <MissionPlanDecisionActions factoryId={factoryId} missionId={mission.id} />
            </div>
          ) : mission.status === 'awaiting_plan_approval' ? (
            <p data-testid="mission-plan-gate-pending-row" className="text-sm text-slate-600">
              The mission is awaiting plan approval, but no plan-gate row is recorded yet. Refresh
              once the workflow opens the gate.
            </p>
          ) : (
            <EmptyState
              testId="mission-plan-gate-empty"
              title="No plan gate is waiting"
              description={
                mission.status === 'planning'
                  ? 'The planner is still composing the plan; the gate appears when the plan is proposed.'
                  : `The mission is ${mission.status.replace(/_/g, ' ')}; the plan gate is already decided.`
              }
            />
          )}
        </CardBody>
      </Card>

      <PlanCard mission={mission} />

      <Card testId="mission-milestones-card">
        <CardHeader
          title="Milestones and features"
          hint="Features run one at a time; a feature is a work item that starts at implement with the mission's spec."
        />
        <CardBody className="space-y-4">
          {orderedMilestones.length === 0 ? (
            planMilestones.length > 0 ? (
              <PlanPreview milestones={planMilestones} />
            ) : (
              <EmptyState
                testId="mission-milestones-empty"
                title="No milestones yet"
                description="The plan has not been approved or materialized; nothing is scheduled."
              />
            )
          ) : (
            orderedMilestones.map((milestone) => (
              <section
                key={milestone.id}
                data-testid="mission-milestone"
                data-milestone-id={milestone.id}
                data-status={milestone.status}
                className="rounded-xl border border-slate-200 bg-white px-3 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={milestoneStatusTone(milestone.status as MissionMilestoneStatusWire)}
                    testId="mission-milestone-status"
                  >
                    {milestone.status}
                  </Badge>
                  <h3 className="text-sm font-semibold text-slate-900">{milestone.title}</h3>
                  <span className="font-mono text-[11px] text-slate-400">
                    #{milestone.ordinal} · {milestone.id}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-slate-500">
                    validation round {milestone.validationRound}
                  </span>
                </div>
                {milestone.description ? (
                  <p className="mt-1 text-xs text-slate-600">{milestone.description}</p>
                ) : null}
                <div className="mt-2">
                  <FeatureRows
                    factoryId={factoryId}
                    missionId={mission.id}
                    milestone={milestone}
                    features={features.filter((feature) => feature.milestoneId === milestone.id)}
                    featureTitleById={featureTitleById}
                  />
                </div>
              </section>
            ))
          )}
        </CardBody>
      </Card>

      <Card testId="mission-validations-card">
        <CardHeader
          title="Validation rounds"
          hint="Fresh validators run at milestone boundaries; findings become fix features, never direct edits."
        />
        <CardBody className="space-y-3">
          {orderedValidations.length === 0 ? (
            <EmptyState
              testId="mission-validations-empty"
              title="No validation rounds yet"
              description="Validations start when a milestone completes."
            />
          ) : (
            orderedValidations.map((validation) => (
              <article
                key={validation.id}
                data-testid="mission-validation"
                data-validation-id={validation.id}
                data-status={validation.status}
                data-kind={validation.kind}
                className="rounded-lg border border-slate-200 px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={validationStatusTone(validation.status)}
                    testId="mission-validation-status"
                  >
                    {validation.status}
                  </Badge>
                  <Badge tone="neutral" mono>
                    {validation.kind}
                  </Badge>
                  <span className="font-mono text-[11px] text-slate-500">
                    milestone {shortMissionId(validation.milestoneId)} · round {validation.round}
                  </span>
                  {validation.verdict ? (
                    <Badge
                      tone={
                        validation.verdict === 'approve'
                          ? 'success'
                          : validation.verdict === 'reject'
                            ? 'danger'
                            : 'warning'
                      }
                      testId="mission-validation-verdict"
                    >
                      {validation.verdict}
                    </Badge>
                  ) : null}
                  {validation.runId ? (
                    <Link
                      href={`/factories/${encoded}/runs/${encodeURIComponent(validation.runId)}`}
                      data-testid="mission-validation-run"
                      className="font-mono text-[11px] text-sky-700 underline decoration-sky-200 underline-offset-2"
                    >
                      validator run
                    </Link>
                  ) : null}
                  <span className="ml-auto text-[11px] text-slate-400">
                    {formatDateTime(validation.updatedAt ?? validation.createdAt)}
                  </span>
                </div>

                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <div data-testid="mission-validation-findings">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Findings
                    </p>
                    {validation.findings.length === 0 ? (
                      <p className="text-xs text-slate-500">No findings recorded.</p>
                    ) : (
                      <ul className="mt-0.5 space-y-0.5">
                        {validation.findings.map((finding, index) => (
                          <li key={index} className="text-xs text-slate-600">
                            {findingLine(finding)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div data-testid="mission-validation-evidence">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Evidence
                    </p>
                    {validation.evidence.length === 0 ? (
                      <p className="text-xs text-slate-500">No evidence recorded.</p>
                    ) : (
                      <ul className="mt-0.5 space-y-0.5">
                        {validation.evidence.map((evidence, index) => (
                          <li key={index} className="font-mono text-[11px] text-slate-600">
                            {compactRecord(evidence)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </article>
            ))
          )}
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card testId="mission-timeline-card">
          <CardHeader
            title="Event timeline"
            hint="Append-only mission events: plan, features, validations, checkpoints, controls."
          />
          <CardBody>
            {orderedEvents.length === 0 ? (
              <EmptyState testId="mission-timeline-empty" title="No mission events recorded yet" />
            ) : (
              <ol data-testid="mission-timeline" className="space-y-1.5">
                {orderedEvents.map((event) => (
                  <li
                    key={event.id}
                    data-testid="mission-event"
                    data-event-type={event.type}
                    data-actor={event.actor ?? ''}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs"
                  >
                    <span className="font-mono font-semibold text-slate-800">{event.type}</span>
                    {event.milestoneId ? (
                      <span className="font-mono text-[11px] text-slate-400">
                        mst {shortMissionId(event.milestoneId)}
                      </span>
                    ) : null}
                    {event.featureId ? (
                      <span className="font-mono text-[11px] text-slate-400">
                        mft {shortMissionId(event.featureId)}
                      </span>
                    ) : null}
                    {event.actor ? (
                      <span className="text-[11px] text-slate-500" data-testid="mission-event-actor">
                        by {event.actor}
                      </span>
                    ) : null}
                    {eventSummary(event.payload) ? (
                      <span className="text-[11px] text-slate-600" data-testid="mission-event-summary">
                        — {eventSummary(event.payload)}
                      </span>
                    ) : null}
                    <span className="ml-auto text-[11px] text-slate-400">
                      {formatDateTime(event.createdAt)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>

        <Card testId="mission-checkpoints-card">
          <CardHeader
            title="Checkpoints"
            hint="Small durable state snapshots; large artifacts stay in the artifact store."
          />
          <CardBody>
            {orderedCheckpoints.length === 0 ? (
              <EmptyState testId="mission-checkpoints-empty" title="No checkpoints recorded yet" />
            ) : (
              <ol data-testid="mission-checkpoints" className="space-y-1.5">
                {orderedCheckpoints.map((checkpoint) => (
                  <li
                    key={checkpoint.id}
                    data-testid="mission-checkpoint"
                    data-kind={checkpoint.kind}
                    data-seq={checkpoint.seq}
                    className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral" mono>
                        #{checkpoint.seq}
                      </Badge>
                      <span className="font-mono font-semibold text-slate-800">{checkpoint.kind}</span>
                      {checkpoint.milestoneId ? (
                        <span className="font-mono text-[11px] text-slate-400">
                          mst {shortMissionId(checkpoint.milestoneId)}
                        </span>
                      ) : null}
                      {checkpoint.featureId ? (
                        <span className="font-mono text-[11px] text-slate-400">
                          mft {shortMissionId(checkpoint.featureId)}
                        </span>
                      ) : null}
                      <span className="ml-auto text-[11px] text-slate-400">
                        {formatDateTime(checkpoint.createdAt)}
                      </span>
                    </div>
                    {compactRecord(checkpoint.state) ? (
                      <p className="mt-1 font-mono text-[11px] text-slate-600" data-testid="mission-checkpoint-state">
                        {compactRecord(checkpoint.state)}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>
      </div>

      <Card testId="mission-work-items-card">
        <CardHeader
          title="Linked work items"
          hint="Every feature is executed by a work item; PRs, reviews and checks live on it."
        />
        {workItems.length === 0 ? (
          <CardBody>
            <EmptyState
              testId="mission-work-items-empty"
              title="No work items yet"
              description="Work items are created as features are dispatched; nothing is inferred from the plan."
            />
          </CardBody>
        ) : (
          <Table
            testId="mission-work-items"
            rowTestId="mission-work-item-row"
            rows={workItems}
            rowKey={(workItem: WorkItemSummary) => workItem.id}
            columns={[
              {
                header: 'Work item',
                cell: (workItem: WorkItemSummary) => (
                  <Link
                    href={`/factories/${encoded}/work-items/${encodeURIComponent(workItem.id)}`}
                    data-testid="mission-work-item-link"
                    className="text-xs font-medium text-slate-800 underline decoration-slate-300 underline-offset-2"
                  >
                    {workItem.title}
                  </Link>
                ),
              },
              {
                header: 'Stage',
                cell: (workItem: WorkItemSummary) => (
                  <Badge tone="info" mono>
                    {workItem.stage}
                  </Badge>
                ),
              },
              {
                header: 'Status',
                cell: (workItem: WorkItemSummary) => (
                  <span data-status={workItem.status}>
                    <Badge tone={workItem.status === 'done' ? 'success' : workItem.status === 'escalated' ? 'danger' : 'neutral'}>
                      {workItem.status}
                    </Badge>
                  </span>
                ),
              },
              {
                header: 'PR',
                cell: (workItem: WorkItemSummary) =>
                  workItem.prUrl ? (
                    <a
                      href={workItem.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[11px] text-emerald-700 underline decoration-emerald-200 underline-offset-2"
                    >
                      #{workItem.prNumber ?? '?'}
                    </a>
                  ) : (
                    <span className="text-[11px] text-slate-400">—</span>
                  ),
              },
              {
                header: 'Updated',
                cell: (workItem: WorkItemSummary) => (
                  <TimeAgo value={workItem.updatedAt ?? workItem.createdAt} className="text-[11px] text-slate-500" />
                ),
              },
            ]}
          />
        )}
      </Card>

      <BudgetCard mission={mission} usage={budgetUsage} />

      <Card testId="mission-gates-card">
        <CardHeader title="Gate decisions" hint="Plan approval and any later mission-level gates, with actor and time." />
        {gates.length === 0 ? (
          <CardBody>
            <EmptyState testId="mission-gates-empty" title="No mission gates recorded yet" />
          </CardBody>
        ) : (
          <Table
            testId="mission-gates"
            rowTestId="mission-gate-row"
            rows={gates}
            rowKey={(gate: MissionGate) => `${gate.gate}:${gate.attempt}`}
            columns={[
              {
                header: 'Gate',
                cell: (gate: MissionGate) => (
                  <span className="font-mono text-xs" data-testid="mission-gate-name">
                    {gate.gate} · #{gate.attempt}
                  </span>
                ),
              },
              {
                header: 'Decision',
                cell: (gate: MissionGate) => (
                  <span data-decision={gate.decision ?? 'pending'}>
                    <Badge
                      tone={
                        gate.decision === null
                          ? 'info'
                          : gate.decision === 'approve'
                            ? 'success'
                            : gate.decision === 'reject'
                              ? 'danger'
                              : 'warning'
                      }
                    >
                      {gate.decision ?? 'pending'}
                    </Badge>
                  </span>
                ),
              },
              {
                header: 'Actor',
                cell: (gate: MissionGate) => (
                  <span className="font-mono text-xs text-slate-600">{gate.actor ?? '—'}</span>
                ),
              },
              {
                header: 'Reason / feedback',
                cell: (gate: MissionGate) => (
                  <span className="text-xs text-slate-600">
                    {gate.feedback ?? gate.reason ?? '—'}
                  </span>
                ),
              },
              {
                header: 'Requested',
                cell: (gate: MissionGate) => (
                  <span className="text-[11px] text-slate-500">{formatDateTime(gate.requestedAt)}</span>
                ),
              },
              {
                header: 'Decided',
                cell: (gate: MissionGate) => (
                  <span className="text-[11px] text-slate-500">{formatDateTime(gate.decidedAt)}</span>
                ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
