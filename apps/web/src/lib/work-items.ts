import type {
  GateDecisionRecord,
  ReviewPacketWire,
  RiskTierWire,
  WorkItemEvent,
  WorkItemStage,
} from './types';
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
export function runsForWorkItem(
  workItemId: string,
  events: Pick<WorkItemEvent, 'type' | 'stage' | 'payload' | 'createdAt'>[],
): WorkItemRunRef[] {
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

/**
 * Newest deterministic review packet (`review.packet`) for this item, or null. The payload is
 * validated defensively: a packet without a valid risk tier is treated as absent rather than
 * rendered with an invented one.
 */
export function reviewPacket(events: WorkItemEvent[]): ReviewPacketWire | null {
  const event = [...events].reverse().find((candidate) => candidate.type === 'review.packet');
  if (!event) return null;
  const payload = event.payload ?? {};
  const riskTier = payload.riskTier;
  if (riskTier !== 'low' && riskTier !== 'medium' && riskTier !== 'high') return null;

  const diff =
    payload.diffStats && typeof payload.diffStats === 'object' && !Array.isArray(payload.diffStats)
      ? (payload.diffStats as Record<string, unknown>)
      : {};
  const assertions = Array.isArray(payload.assertions)
    ? payload.assertions.map((assertion) => {
        const record = (assertion ?? {}) as Record<string, unknown>;
        return {
          id: stringOf(record.id),
          status: stringOf(record.status) || 'unknown',
          evidence: stringOf(record.evidence),
        };
      })
    : [];

  const proofArtifacts = Array.isArray(payload.proofArtifacts)
    ? payload.proofArtifacts.flatMap((entry) => {
        const record = recordOf(entry);
        const kind = record.kind;
        if (!isProofKind(kind) || typeof record.path !== 'string') return [];
        return [
          {
            kind,
            path: record.path,
            label: stringOf(record.label),
            ...(typeof record.commit === 'string' ? { commit: record.commit } : {}),
            ...(typeof record.hash === 'string' ? { hash: record.hash } : {}),
          },
        ];
      })
    : undefined;

  const readFirst = Array.isArray(payload.readFirst)
    ? payload.readFirst.flatMap((entry) => {
        const record = recordOf(entry);
        if (typeof record.path !== 'string') return [];
        return [{ path: record.path, why: stringOf(record.why) }];
      })
    : undefined;

  const decisions = Array.isArray(payload.decisions)
    ? payload.decisions.map((entry) => {
        const record = recordOf(entry);
        return {
          at: stringOf(record.at),
          actor: stringOf(record.actor),
          decision: stringOf(record.decision),
          reason: stringOf(record.reason),
          ...(typeof record.ref === 'string' ? { ref: record.ref } : {}),
        };
      })
    : undefined;

  const reviewerRoles = stringList(payload.reviewerRoles);
  const slopStatus = payload.slopStatus;
  const slopBudget = recordOf(payload.slopBudget);
  const slopActual = recordOf(payload.slopActual);
  const blastRadius = recordOf(payload.blastRadius);
  const standards = recordOf(payload.standards);
  const comprehension = recordOf(payload.comprehension);

  return {
    riskTier: riskTier as RiskTierWire,
    intent: stringOf(payload.intent),
    planRef: stringOf(payload.planRef) || null,
    changedFiles: numberOf(payload.changedFiles) ?? 0,
    diffStats: {
      additions: numberOf(diff.additions) ?? 0,
      deletions: numberOf(diff.deletions) ?? 0,
    },
    assertions,
    architectureImpact: stringList(payload.architectureImpact),
    openQuestions: stringList(payload.openQuestions),
    reviewerChecklist: stringList(payload.reviewerChecklist),
    // Review packet v2 (`add-anti-slop-budgets-and-proof`). Only fields the payload actually
    // carries are surfaced; a pre-v2 packet leaves them absent so the card omits the section
    // instead of showing a fabricated zero.
    ...(Object.keys(slopBudget).length > 0
      ? {
          slopBudget: {
            maxDiffLines: numberOf(slopBudget.maxDiffLines) ?? 0,
            maxChangedFiles: numberOf(slopBudget.maxChangedFiles) ?? 0,
            maxNewDependencies: numberOf(slopBudget.maxNewDependencies) ?? 0,
            maxDuplicationDeltaPercent: numberOf(slopBudget.maxDuplicationDeltaPercent) ?? 0,
            maxComplexityDelta: numberOf(slopBudget.maxComplexityDelta) ?? 0,
          },
        }
      : {}),
    ...(Object.keys(slopActual).length > 0
      ? {
          slopActual: {
            changedFiles: numberOf(slopActual.changedFiles) ?? 0,
            additions: numberOf(slopActual.additions) ?? 0,
            deletions: numberOf(slopActual.deletions) ?? 0,
            diffLines: numberOf(slopActual.diffLines) ?? 0,
            newDependencies: numberOf(slopActual.newDependencies) ?? 0,
            duplicationDeltaPercent: numberOf(slopActual.duplicationDeltaPercent),
            complexityDelta: numberOf(slopActual.complexityDelta),
          },
        }
      : {}),
    ...(slopStatus === 'pass' || slopStatus === 'exceeded' || slopStatus === 'unknown'
      ? { slopStatus }
      : {}),
    ...(Object.keys(blastRadius).length > 0
      ? {
          blastRadius: {
            paths: stringList(blastRadius.paths),
            highRiskPaths: stringList(blastRadius.highRiskPaths),
            publicApiChanges: numberOf(blastRadius.publicApiChanges) ?? 0,
            schemaChanges: numberOf(blastRadius.schemaChanges) ?? 0,
          },
        }
      : {}),
    // Standards guard (`add-risk-aware-routing-and-standards`): only surfaced when the packet
    // carries it, so a packet recorded before the guard omits the card instead of inventing caps.
    ...(Object.keys(standards).length > 0
      ? {
          standards: {
            maxPublicApiChanges: numberOf(standards.maxPublicApiChanges) ?? 0,
            maxSchemaChanges: numberOf(standards.maxSchemaChanges) ?? 0,
            publicApiChanges: numberOf(standards.publicApiChanges) ?? 0,
            schemaChanges: numberOf(standards.schemaChanges) ?? 0,
            status: standards.status === 'exceeded' ? 'exceeded' : 'pass',
          },
        }
      : {}),
    ...(proofArtifacts ? { proofArtifacts } : {}),
    ...(readFirst ? { readFirst } : {}),
    ...(decisions ? { decisions } : {}),
    ...(reviewerRoles.length > 0 ? { reviewerRoles } : {}),
    ...(Object.keys(comprehension).length > 0
      ? {
          comprehension: {
            estimatedReadMinutes: numberOf(comprehension.estimatedReadMinutes) ?? 0,
            filesWithoutTests: numberOf(comprehension.filesWithoutTests) ?? 0,
            modulesWithoutOwner: numberOf(comprehension.modulesWithoutOwner) ?? 0,
          },
        }
      : {}),
    ...(typeof payload.contextPackRef === 'string' ? { contextPackRef: payload.contextPackRef } : {}),
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

/* ------------------------------------------------------- decision trail */

export type DecisionTrailKind = 'plan' | 'gate' | 'review' | 'pr' | 'merge' | 'incident';

/**
 * One chronological row of the unified decision trail (change
 * `add-review-capacity-and-compounding`). Every row comes from a real artifact — the plan ref
 * persisted on the item, a decided gate, a review verdict event, the PR/merge events or an
 * incident event — so an empty trail stays empty instead of being padded.
 */
export interface DecisionTrailRow {
  /** Stable key for React lists; built from the source record. */
  key: string;
  kind: DecisionTrailKind;
  /** Null when the source carries no timestamp; the UI renders an explicit dash. */
  at: string | null;
  actor: string | null;
  decision: string;
  /** Reason / feedback / summary behind the decision, when the source has one. */
  reason: string | null;
  /** Stable reference: plan ref, gate id, PR url, commit sha or event type. */
  ref: string | null;
}

function trailSortKey(row: DecisionTrailRow): number {
  if (!row.at) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(row.at);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Builds the decision trail from the plan ref and the durable read model. Order is
 * chronological; undated rows (a plan ref without a packet timestamp) come first. Only
 * decided gates and recorded events contribute — a pending gate is not a decision and is
 * already rendered by the gate card.
 */
export function decisionTrail(input: {
  planRef?: string | null;
  gates: GateDecisionRecord[];
  events: WorkItemEvent[];
}): DecisionTrailRow[] {
  const rows: DecisionTrailRow[] = [];
  const planRef = typeof input.planRef === 'string' && input.planRef.trim().length > 0
    ? input.planRef
    : null;

  if (planRef) {
    // The packet is the only event that carries the plan ref; its timestamp dates the plan row.
    const packet = [...input.events]
      .reverse()
      .find(
        (event) =>
          event.type === 'review.packet' && stringOf(event.payload.planRef) === planRef,
      );
    rows.push({
      key: `plan:${planRef}`,
      kind: 'plan',
      at: packet?.createdAt ?? null,
      actor: null,
      decision: 'plan',
      reason: null,
      ref: planRef,
    });
  }

  for (const gate of input.gates) {
    if (gate.decision === null) continue;
    rows.push({
      key: `gate:${gate.stage}:${gate.attempt}`,
      kind: 'gate',
      at: gate.decidedAt,
      actor: gate.actor,
      decision: `${gate.stage} ${gate.decision}`,
      reason: gate.feedback ?? gate.reason ?? null,
      ref: `gate ${gate.gate} · ${gate.stage}#${gate.attempt}${gate.automatic ? ' · automatic' : ''}`,
    });
  }

  for (const event of input.events) {
    if (event.type === 'review.verdict') {
      const verdict = stringOf(event.payload.verdict) || 'unknown';
      const reviewer = stringOf(event.payload.reviewer);
      const confidence = numberOf(event.payload.confidence);
      rows.push({
        key: `review:${event.id}`,
        kind: 'review',
        at: event.createdAt,
        actor: reviewer || event.actor,
        decision: `review ${verdict}`,
        reason: confidence !== null ? `confidence ${confidence}` : null,
        ref: event.payload.advisory === true ? 'advisory' : null,
      });
      continue;
    }

    if (event.type === 'pr.opened') {
      const prUrl = stringOf(event.payload.prUrl);
      const prNumber = numberOrNull(event.payload.prNumber);
      rows.push({
        key: `pr:${event.id}`,
        kind: 'pr',
        at: event.createdAt,
        actor: event.actor,
        decision: prNumber !== null ? `PR #${prNumber} opened` : 'PR opened',
        reason: null,
        ref: prUrl || null,
      });
      continue;
    }

    if (event.type === 'merge.merged') {
      const sha = stringOf(event.payload.sha);
      rows.push({
        key: `merge:${event.id}`,
        kind: 'merge',
        at: event.createdAt,
        actor: event.actor,
        decision: 'merged',
        reason: null,
        ref: sha || null,
      });
      continue;
    }

    // Incidents: an explicit incident event, or a revert the merge queue recorded.
    if (/incident/i.test(event.type) || event.type === 'merge.reverted') {
      rows.push({
        key: `incident:${event.id}`,
        kind: 'incident',
        at: event.createdAt,
        actor: event.actor,
        decision: event.type === 'merge.reverted' ? 'reverted' : 'incident',
        reason: stringOf(event.payload.reason) || null,
        ref: event.type,
      });
    }
  }

  // A merge recorded only through the ship status event still belongs to the trail.
  const hasMergeEvent = rows.some((row) => row.kind === 'merge');
  if (!hasMergeEvent) {
    const at = mergedAt(input.events);
    if (at) {
      rows.push({
        key: 'merge:status',
        kind: 'merge',
        at,
        actor: null,
        decision: 'merged',
        reason: null,
        ref: null,
      });
    }
  }

  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const delta = trailSortKey(a.row) - trailSortKey(b.row);
      return delta !== 0 ? delta : a.index - b.index;
    })
    .map(({ row }) => row);
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

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const PROOF_KINDS = ['screenshot', 'video', 'html', 'curl', 'report', 'file'] as const;

function isProofKind(value: unknown): value is (typeof PROOF_KINDS)[number] {
  return typeof value === 'string' && (PROOF_KINDS as readonly string[]).includes(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
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
