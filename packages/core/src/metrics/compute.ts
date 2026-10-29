import type { MetricsWindow } from './window';

/**
 * Factory metrics as pure functions over read-model rows (ADR-017).
 *
 * Every metric returns `{value, unit, sampleSize, definition}`. When there is no data the
 * value is `null` plus a `reason` — never a fabricated zero. The definitions are part of
 * the response so the UI can show what a number means.
 */

export interface WorkItemMetricRow {
  id: string;
  type: string;
  status: string;
  createdAt: string | null;
  /** Timestamp of the terminal `work_item.status` done event, when present. */
  doneAt: string | null;
  prUrl: string | null;
  prNumber: number | null;
}

export interface GateMetricRow {
  workItemId: string;
  gate: string;
  automatic: boolean;
  requestedAt: string | null;
  decidedAt: string | null;
}

export interface PermissionMetricRow {
  runId: string;
  decidedAt: string | null;
}

export interface RunMetricRow {
  id: string;
  startedAt: string | null;
  costUsd: number | null;
  /** Parsed from the stage run id convention; `null` for chat/ad-hoc runs. */
  stage: string | null;
  workItemId: string | null;
}

export interface CheckMetricRow {
  workItemId: string;
  green: boolean;
  createdAt: string | null;
}

export interface MetricsInput {
  window: MetricsWindow;
  workItems: WorkItemMetricRow[];
  gates: GateMetricRow[];
  permissions: PermissionMetricRow[];
  runs: RunMetricRow[];
  checks: CheckMetricRow[];
}

export interface MetricCard {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  sampleSize: number;
  definition: string;
  reason?: string;
}

export interface StageCost {
  stage: string;
  costUsd: number;
  runCount: number;
}

export interface FactoryMetricsResult {
  metrics: MetricCard[];
  costByStage: StageCost[];
  unattributedCost: { costUsd: number; runCount: number };
}

const HOUR_MS = 3_600_000;
const WEEK_DAYS = 7;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function hoursBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return (to - from) / HOUR_MS;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function buildFactoryMetrics(input: MetricsInput): FactoryMetricsResult {
  const prItems = input.workItems.filter((item) => item.prUrl);
  const prCount = prItems.length;
  const prIds = new Set(prItems.map((item) => item.id));
  const donePrItems = prItems.filter((item) => item.status === 'done' && item.doneAt);

  const attributedRuns = input.runs.filter(
    (run) => run.workItemId !== null && prIds.has(run.workItemId),
  );
  const attributedCost = attributedRuns.reduce((total, run) => total + (run.costUsd ?? 0), 0);

  const weeks = Math.max(input.window.days / WEEK_DAYS, 1 / WEEK_DAYS);

  const throughput: MetricCard = {
    key: 'throughput',
    label: 'PR throughput',
    value: prCount === 0 ? null : round(prCount / weeks),
    unit: 'PRs/week',
    sampleSize: prCount,
    definition:
      'Work items that opened a pull request in the window, divided by the window length in weeks.',
    ...(prCount === 0 ? { reason: 'no pull requests opened for work items in this window' } : {}),
  };

  const costPerPr: MetricCard = {
    key: 'costPerPr',
    label: 'Cost per PR',
    value:
      prCount === 0 || attributedRuns.length === 0
        ? null
        : round(attributedCost / prCount),
    unit: 'USD/PR',
    sampleSize: prCount,
    definition:
      'Sum of run cost for stage runs attributed to work items that opened a PR in the window, divided by the number of those PRs. Unattributed cost is reported separately.',
    ...(prCount === 0
      ? { reason: 'no pull requests opened for work items in this window' }
      : attributedRuns.length === 0
        ? { reason: 'no stage runs attributed to those pull requests in this window' }
        : {}),
  };

  const cycleTimes = donePrItems
    .map((item) => hoursBetween(item.createdAt, item.doneAt))
    .filter((value): value is number => value !== null);
  const cycleTime: MetricCard = {
    key: 'cycleTime',
    label: 'Cycle time',
    value: cycleTimes.length === 0 ? null : round(average(cycleTimes) as number),
    unit: 'hours',
    sampleSize: cycleTimes.length,
    definition:
      'Average time from work item creation (kickoff) to the terminal done event for work items that opened a PR and completed.',
    ...(cycleTimes.length === 0
      ? { reason: 'no completed PR work items with a recorded done event in this window' }
      : {}),
  };

  const firstHumanReview = new Map<string, string>();
  for (const gate of input.gates) {
    if (gate.automatic || !gate.decidedAt) continue;
    const existing = firstHumanReview.get(gate.workItemId);
    if (!existing || Date.parse(gate.decidedAt) < Date.parse(existing)) {
      firstHumanReview.set(gate.workItemId, gate.decidedAt);
    }
  }
  const reviewDurations: number[] = [];
  for (const item of input.workItems) {
    const reviewAt = firstHumanReview.get(item.id);
    const duration = hoursBetween(item.createdAt, reviewAt ?? null);
    if (duration !== null) reviewDurations.push(duration);
  }
  const timeToFirstReview: MetricCard = {
    key: 'timeToFirstHumanReview',
    label: 'Time to first human review',
    value: reviewDurations.length === 0 ? null : round(average(reviewDurations) as number),
    unit: 'hours',
    sampleSize: reviewDurations.length,
    definition:
      'Average time from work item creation to the first non-automatic gate decision by a human.',
    ...(reviewDurations.length === 0
      ? { reason: 'no human gate decisions were recorded in this window' }
      : {}),
  };

  const humanGateTouchpoints = input.gates.filter(
    (gate) => !gate.automatic && gate.decidedAt !== null,
  ).length;
  const permissionTouchpoints = input.permissions.filter(
    (permission) => permission.decidedAt !== null,
  ).length;
  const touchpoints: MetricCard = {
    key: 'touchpointsPerPr',
    label: 'Human touchpoints per PR',
    value:
      prCount === 0
        ? null
        : round((humanGateTouchpoints + permissionTouchpoints) / prCount),
    unit: 'touchpoints/PR',
    sampleSize: prCount,
    definition:
      'Human gate decisions plus human permission decisions, divided by PRs opened in the window. Human PR comments are added when the forge backend persists them.',
    ...(prCount === 0 ? { reason: 'no pull requests opened for work items in this window' } : {}),
  };

  const decidedGates = input.gates.filter((gate) => gate.decidedAt !== null);
  const automaticGates = decidedGates.filter((gate) => gate.automatic).length;
  const automation: MetricCard = {
    key: 'automationPercent',
    label: 'Automation',
    value:
      decidedGates.length === 0
        ? null
        : round((automaticGates / decidedGates.length) * 100),
    unit: '%',
    sampleSize: decidedGates.length,
    definition:
      'Share of decided stage gates resolved automatically (agent or SLA policy) rather than by a human.',
    ...(decidedGates.length === 0 ? { reason: 'no gate decisions recorded in this window' } : {}),
  };

  const redChecks = input.checks.filter((check) => !check.green).length;
  const defectRate: MetricCard = {
    key: 'defectRate',
    label: 'Defect rate',
    value:
      prCount === 0 || input.checks.length === 0
        ? null
        : round(redChecks / prCount),
    unit: 'red-check PRs/PR',
    sampleSize: prCount,
    definition:
      'Work items whose forge checks were recorded red, divided by PRs opened in the window. Only forge-recorded checks count; nothing is inferred from diffs.',
    ...(prCount === 0
      ? { reason: 'no pull requests opened for work items in this window' }
      : input.checks.length === 0
        ? { reason: 'no forge check results were recorded in this window' }
        : {}),
  };

  const stageTotals = new Map<string, StageCost>();
  let unattributedCost = 0;
  let unattributedRuns = 0;
  for (const run of input.runs) {
    if (run.stage === null) {
      unattributedCost += run.costUsd ?? 0;
      unattributedRuns += 1;
      continue;
    }
    const current = stageTotals.get(run.stage) ?? { stage: run.stage, costUsd: 0, runCount: 0 };
    current.costUsd += run.costUsd ?? 0;
    current.runCount += 1;
    stageTotals.set(run.stage, current);
  }

  return {
    metrics: [
      throughput,
      costPerPr,
      cycleTime,
      timeToFirstReview,
      touchpoints,
      automation,
      defectRate,
    ],
    costByStage: [...stageTotals.values()]
      .map((stage) => ({ ...stage, costUsd: round(stage.costUsd) }))
      .sort((left, right) => left.stage.localeCompare(right.stage)),
    unattributedCost: {
      costUsd: round(unattributedCost),
      runCount: unattributedRuns,
    },
  };
}
