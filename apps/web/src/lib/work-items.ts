import type { WorkItemEvent, WorkItemStage } from './types';
import { WORK_ITEM_STAGES } from './types';

/**
 * Read-only derivations over the work-item event log (`work_item_events`).
 *
 * The API projects the raw log, not a per-view model, so the console derives the timeline,
 * reviewer reports and run links here. Nothing is invented: an absent event renders as an
 * explicit empty state, and run ids are reconstructed with the orchestrator's documented
 * `stageRunId` scheme (one run per stage attempt / reviewer).
 */

export interface StageTransition {
  id: number;
  from: string;
  to: string;
  by: string;
  actor: string | null;
  reason: string | null;
  at: string | null;
}

export function stageTimeline(events: WorkItemEvent[]): StageTransition[] {
  return events
    .filter((event) => event.type === 'stage.changed')
    .map((event) => {
      const payload = event.payload ?? {};
      return {
        id: event.id,
        from: stringOf(payload.from),
        to: stringOf(payload.to),
        by: stringOf(payload.by) || event.actor || 'foreman',
        actor: stringOf(payload.actor) || event.actor,
        reason: stringOf(payload.reason) || null,
        at: event.createdAt,
      };
    });
}

export interface ReviewFindingView {
  reviewer: string;
  severity: string;
  summary: string;
  file: string | null;
}

export interface ReviewerReportView {
  reviewer: string;
  verdict: string;
  confidence: number | null;
  runId: string | null;
  findings: ReviewFindingView[];
  at: string | null;
}

/** One report per independent reviewer (`review.verdict` with a `reviewer` payload). */
export function reviewerReports(events: WorkItemEvent[]): ReviewerReportView[] {
  return events
    .filter((event) => event.type === 'review.verdict' && typeof event.payload.reviewer === 'string')
    .map((event) => ({
      reviewer: stringOf(event.payload.reviewer) || event.actor || 'reviewer',
      verdict: stringOf(event.payload.verdict) || 'unknown',
      confidence: numberOf(event.payload.confidence),
      runId: stringOf(event.payload.runId) || null,
      findings: findingsOf(event.payload.findings),
      at: event.createdAt,
    }));
}

export interface JudgeVerdictView {
  verdict: string;
  confidence: number | null;
  reviewers: number | null;
  advisory: boolean;
  incomplete: boolean;
  findings: ReviewFindingView[];
  at: string | null;
}

/** The judge's merged advisory verdict (`review.verdict` from the judge). */
export function judgeVerdict(events: WorkItemEvent[]): JudgeVerdictView | null {
  const judged = events.filter(
    (event) =>
      event.type === 'review.verdict' &&
      (event.actor === 'judge' || typeof event.payload.reviewers !== 'undefined'),
  );
  const event = judged[judged.length - 1];
  if (!event) return null;
  return {
    verdict: stringOf(event.payload.verdict) || 'unknown',
    confidence: numberOf(event.payload.confidence),
    reviewers: numberOrNull(event.payload.reviewers),
    advisory: event.payload.advisory === true,
    incomplete: event.payload.incomplete === true,
    findings: findingsOf(event.payload.findings),
    at: event.createdAt,
  };
}

export interface WorkItemRunRef {
  runId: string;
  label: string;
  stage: string | null;
  at: string | null;
}

/** Reconstructs the run ids the loop used for this item (deterministic `stageRunId`). */
export function runsForWorkItem(workItemId: string, events: WorkItemEvent[]): WorkItemRunRef[] {
  const suffix = workItemId.replace(/^wi_/, '');
  const seen = new Set<string>();
  const runs: WorkItemRunRef[] = [];

  const push = (run: WorkItemRunRef): void => {
    if (seen.has(run.runId)) return;
    seen.add(run.runId);
    runs.push(run);
  };

  for (const event of events) {
    if (event.type === 'dispatch.requested') {
      const stage = stringOf(event.payload.stage) || event.stage;
      const attempt = numberOrNull(event.payload.attempt) ?? 1;
      if (!stage) continue;
      push({
        runId: `run_${suffix}_${stage}_${attempt}`,
        label: `${stage} · attempt ${attempt}`,
        stage,
        at: event.createdAt,
      });
    }
    if (event.type === 'review.verdict') {
      const runId = stringOf(event.payload.runId);
      if (!runId) continue;
      const reviewer = stringOf(event.payload.reviewer) || 'reviewer';
      push({
        runId,
        label: `${reviewer} · independent review`,
        stage: event.stage,
        at: event.createdAt,
      });
    }
  }

  return runs;
}

export interface StatusEventView {
  status: string;
  reason: string | null;
  actor: string | null;
  at: string | null;
}

export function statusEvents(events: WorkItemEvent[]): StatusEventView[] {
  return events
    .filter((event) => event.type === 'work_item.status')
    .map((event) => ({
      status: stringOf(event.payload.status),
      reason: stringOf(event.payload.reason) || null,
      actor: event.actor,
      at: event.createdAt,
    }));
}

export interface RetryEventView {
  previousStatus: string | null;
  actor: string | null;
  reason: string | null;
  attempt: number | null;
  workflowId: string | null;
  at: string | null;
}

/** Every `work_item.retried` event: who re-opened the item, why, and under which attempt. */
export function retryEvents(events: WorkItemEvent[]): RetryEventView[] {
  return events
    .filter((event) => event.type === 'work_item.retried')
    .map((event) => ({
      previousStatus: stringOf(event.payload.previousStatus) || null,
      actor: stringOf(event.payload.actor) || event.actor,
      reason: stringOf(event.payload.reason) || null,
      attempt: numberOrNull(event.payload.attempt),
      workflowId: stringOf(event.payload.workflowId) || null,
      at: event.createdAt,
    }));
}

/** True once the loop recorded a merge (the ship gate approved and the forge merged). */
export function mergedAt(events: WorkItemEvent[]): string | null {
  const statuses = statusEvents(events).filter((entry) => /merge/i.test(entry.reason ?? ''));
  return statuses.length > 0 ? (statuses[statuses.length - 1]?.at ?? null) : null;
}

export interface PrOpenedView {
  prUrl: string;
  prNumber: number | null;
  at: string | null;
}

export function prOpened(events: WorkItemEvent[]): PrOpenedView | null {
  const event = [...events].reverse().find((candidate) => candidate.type === 'pr.opened');
  if (!event) return null;
  return {
    prUrl: stringOf(event.payload.prUrl),
    prNumber: numberOrNull(event.payload.prNumber),
    at: event.createdAt,
  };
}

export interface ChecksView {
  green: boolean;
  checks: { name?: string; status?: string; conclusion?: string }[];
  at: string | null;
}

export function checksRecorded(events: WorkItemEvent[]): ChecksView | null {
  const event = [...events].reverse().find((candidate) => candidate.type === 'checks.recorded');
  if (!event) return null;
  const raw = Array.isArray(event.payload.checks) ? event.payload.checks : [];
  return {
    green: event.payload.green === true,
    checks: raw.map((check) => {
      const record = (check ?? {}) as Record<string, unknown>;
      return {
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        ...(typeof record.status === 'string' ? { status: record.status } : {}),
        ...(typeof record.conclusion === 'string' ? { conclusion: record.conclusion } : {}),
      };
    }),
    at: event.createdAt,
  };
}

export interface AutonomyEventView {
  type: 'autonomy.enabled' | 'autonomy.paused' | 'autonomy.refused';
  actor: string | null;
  reason: string | null;
  at: string | null;
}

/**
 * Latest autonomy event recorded for a work item. The API has no `GET /autonomy` read
 * endpoint yet, so the event log is the only durable projection of a kill-switch change.
 */
export function lastAutonomyEvent(events: WorkItemEvent[]): AutonomyEventView | null {
  const types = new Set(['autonomy.enabled', 'autonomy.paused', 'autonomy.refused']);
  const event = [...events].reverse().find((candidate) => types.has(candidate.type));
  if (!event) return null;
  return {
    type: event.type as AutonomyEventView['type'],
    actor: event.actor,
    reason: stringOf(event.payload.reason) || null,
    at: event.createdAt,
  };
}

export interface SlaState {
  /** Whole seconds until the SLA (negative when overdue). */
  secondsRemaining: number | null;
  label: string;
  overdue: boolean;
}

export function slaState(slaAt: string | null, now: number = Date.now()): SlaState {
  if (!slaAt) return { secondsRemaining: null, label: 'no SLA', overdue: false };
  const deadline = Date.parse(slaAt);
  if (Number.isNaN(deadline)) return { secondsRemaining: null, label: 'no SLA', overdue: false };
  const secondsRemaining = Math.round((deadline - now) / 1000);
  return {
    secondsRemaining,
    label: humanizeSeconds(secondsRemaining),
    overdue: secondsRemaining < 0,
  };
}

export function humanizeSeconds(seconds: number): string {
  const abs = Math.abs(seconds);
  const prefix = seconds < 0 ? 'overdue by ' : 'due in ';
  if (abs < 60) return `${prefix}${abs}s`;
  if (abs < 3600) return `${prefix}${Math.round(abs / 60)}m`;
  if (abs < 86_400) return `${prefix}${(abs / 3600).toFixed(1)}h`;
  return `${prefix}${(abs / 86_400).toFixed(1)}d`;
}

/**
 * Statuses a work item can be retried from (spec `factory-loop` › Work-item retry).
 * `active` and `done` are never retryable; `failed` is accepted for forward compatibility
 * even though no writer produces it today.
 */
export const RETRYABLE_WORK_ITEM_STATUSES = ['escalated', 'failed', 'blocked', 'cancelled'];

export function canRetryWorkItem(status: string): boolean {
  return RETRYABLE_WORK_ITEM_STATUSES.includes(status);
}

export function isLoopStage(value: string): value is WorkItemStage {
  return (WORK_ITEM_STAGES as readonly string[]).includes(value);
}

/** Board order, with any unknown stage appended (never silently dropped). */
export function boardStages(items: { stage: string }[]): string[] {
  const extra = [...new Set(items.map((item) => item.stage))].filter(
    (stage) => !isLoopStage(stage),
  );
  return [...WORK_ITEM_STAGES, ...extra];
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return numberOf(value);
}

function findingsOf(value: unknown): ReviewFindingView[] {
  if (!Array.isArray(value)) return [];
  return value.map((finding) => {
    const record = (finding ?? {}) as Record<string, unknown>;
    return {
      reviewer: stringOf(record.reviewer) || 'reviewer',
      severity: stringOf(record.severity) || 'info',
      summary: stringOf(record.summary),
      file: stringOf(record.file) || null,
    };
  });
}
