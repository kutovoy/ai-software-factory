import { readFile } from 'node:fs/promises';
import {
  appendWorkItemEvent,
  attachPullRequest,
  getAutonomyState,
  getWorkItem,
  getWorkItemCancel,
  listWorkItemEvents,
  markWorkItemCancelled,
  recordGateDecision,
  requestGateDecision,
  setWorkItemStatus,
  transitionWorkItem,
  type AgentVerdict,
  type AutonomyState,
  type GateDecisionValue,
  type LoopStage,
  type ReviewPacket,
  type RiskTier,
  type WorkItemCancelState,
  type WorkItemEvent,
  type WorkItemStatus,
} from '@factory/core';
import { loadConfig } from '../config';
import { getSql } from '../db';
import { patchPath } from '../run-dir';

/**
 * Work item persistence activities.
 *
 * All reads/writes go through `@factory/core`'s repository with the worker's SQL handle;
 * the workflow never touches Postgres (deterministic sandbox). Activities are idempotent
 * (guarded transitions, pending-only gate writes, unchanged-PR no-ops), so Temporal
 * retries are free.
 */

export async function recordStageTransition(args: {
  workItemId: string;
  from: LoopStage;
  to: LoopStage;
  by: string;
  actor?: string | null;
  reason?: string | null;
  loopCountDelta?: number;
}): Promise<void> {
  await transitionWorkItem(getSql(), args);
}

export async function recordGateRequest(args: {
  workItemId: string;
  stage: LoopStage;
  attempt: number;
  gate: string;
  workflowId: string;
  slaAt?: string | null;
}): Promise<void> {
  await requestGateDecision(getSql(), args);
}

export async function resolveGateDecision(args: {
  workItemId: string;
  stage: LoopStage;
  attempt: number;
  decision: GateDecisionValue;
  actor: string;
  reason?: string | null;
  feedback?: string | null;
  verdict?: AgentVerdict | null;
  automatic?: boolean;
}): Promise<void> {
  await recordGateDecision(getSql(), args);
}

export async function attachWorkItemPullRequest(args: {
  workItemId: string;
  prUrl: string;
  prNumber?: number | null;
}): Promise<void> {
  await attachPullRequest(getSql(), args);
}

export async function setWorkItemStatusActivity(args: {
  workItemId: string;
  status: WorkItemStatus;
  actor?: string;
  reason?: string | null;
}): Promise<void> {
  await setWorkItemStatus(getSql(), args);
}

export async function recordWorkItemEvent(args: {
  workItemId: string;
  type: string;
  stage?: string | null;
  actor?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await appendWorkItemEvent(getSql(), args);
}

export function emptyAutonomyState(factory: string): AutonomyState {
  return {
    factory,
    enabled: false,
    paused: false,
    actor: null,
    reason: null,
    overrideActor: null,
    overrideReason: null,
    benchmarkGateRequired: false,
    updatedAt: null,
  };
}

/** Read-model autonomy snapshot (kill switch + lights-off policy). */
export async function readAutonomyState(args: { factory: string }): Promise<AutonomyState> {
  return (await getAutonomyState(getSql(), args.factory)) ?? emptyAutonomyState(args.factory);
}

/** Recorded cancellation request, checked before every dispatch (task 1.3). */
export async function readWorkItemCancel(args: {
  workItemId: string;
}): Promise<WorkItemCancelState> {
  return await getWorkItemCancel(getSql(), args.workItemId);
}

/** Terminal cancellation write: `cancelled` + exactly one `work_item.cancelled` event. */
export async function cancelWorkItem(args: {
  workItemId: string;
  stage?: string | null;
  actor?: string | null;
  reason?: string | null;
}): Promise<void> {
  await markWorkItemCancelled(getSql(), args);
}

/* ------------------------------------------------------------ review packet */

/** The fixed checklist shown with every deterministic review packet. */
export const REVIEWER_CHECKLIST = [
  'Intent matches the approved plan and the vertical slice.',
  'The diff stays inside the intended scope; no unrelated files changed.',
  'Every required assertion passed with concrete evidence.',
  'No architecture boundary, dependency-cycle or public-API regression.',
  'No new duplication, dead code or unjustified dependency.',
  'Open questions are answered or explicitly accepted by the reviewer.',
];

export interface DiffStats {
  changedFiles: number;
  additions: number;
  deletions: number;
}

/** Counts changed files and +/- lines from a unified diff. Missing input is all zeroes. */
export function parsePatchStats(patch: string): DiffStats {
  if (typeof patch !== 'string' || patch.length === 0) {
    return { changedFiles: 0, additions: 0, deletions: 0 };
  }
  let changedFiles = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) changedFiles += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { changedFiles, additions, deletions };
}

export interface PacketAssertion {
  id: string;
  status: string;
  evidence: string;
}

/**
 * Reads the newest `validation.evidence` event and maps its `checks` into packet
 * assertions. Malformed entries are ignored; no event means no assertions.
 */
export function assertionsFromWorkItemEvents(events: WorkItemEvent[]): PacketAssertion[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'validation.evidence') continue;
    const checks = event.payload?.checks;
    if (!Array.isArray(checks)) continue;
    const assertions: PacketAssertion[] = [];
    for (const entry of checks) {
      if (typeof entry !== 'object' || entry === null) continue;
      const check = entry as Record<string, unknown>;
      const id =
        typeof check.checkId === 'string'
          ? check.checkId
          : typeof check.id === 'string'
            ? check.id
            : null;
      const status = typeof check.status === 'string' ? check.status : null;
      if (!id || !status) continue;
      const evidence =
        typeof check.detail === 'string'
          ? check.detail
          : typeof check.evidence === 'string'
            ? check.evidence
            : '';
      assertions.push({ id, status, evidence });
    }
    return assertions;
  }
  return [];
}

function packetFromPayload(
  payload: Record<string, unknown>,
  fallback: { riskTier: RiskTier; intent: string },
): ReviewPacket {
  const diffStats =
    typeof payload.diffStats === 'object' && payload.diffStats !== null
      ? (payload.diffStats as Record<string, unknown>)
      : {};
  return {
    riskTier:
      payload.riskTier === 'low' || payload.riskTier === 'medium' || payload.riskTier === 'high'
        ? payload.riskTier
        : fallback.riskTier,
    intent: typeof payload.intent === 'string' ? payload.intent : fallback.intent,
    planRef: typeof payload.planRef === 'string' ? payload.planRef : null,
    changedFiles:
      typeof payload.changedFiles === 'number' && Number.isFinite(payload.changedFiles)
        ? payload.changedFiles
        : 0,
    diffStats: {
      additions:
        typeof diffStats.additions === 'number' && Number.isFinite(diffStats.additions)
          ? diffStats.additions
          : 0,
      deletions:
        typeof diffStats.deletions === 'number' && Number.isFinite(diffStats.deletions)
          ? diffStats.deletions
          : 0,
    },
    assertions: Array.isArray(payload.assertions)
      ? payload.assertions
          .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
          .map((entry) => ({
            id: typeof entry.id === 'string' ? entry.id : '',
            status: typeof entry.status === 'string' ? entry.status : '',
            evidence: typeof entry.evidence === 'string' ? entry.evidence : '',
          }))
          .filter((entry) => entry.id.length > 0)
      : [],
    architectureImpact: Array.isArray(payload.architectureImpact)
      ? payload.architectureImpact.filter((entry): entry is string => typeof entry === 'string')
      : [],
    openQuestions: Array.isArray(payload.openQuestions)
      ? payload.openQuestions.filter((entry): entry is string => typeof entry === 'string')
      : [],
    reviewerChecklist: Array.isArray(payload.reviewerChecklist)
      ? payload.reviewerChecklist.filter((entry): entry is string => typeof entry === 'string')
      : [...REVIEWER_CHECKLIST],
  };
}

/**
 * Deterministic review packet (change `harden-factory-quality`, task 5.1).
 *
 * Assembled from plan metadata, validation evidence and the captured patch — never model
 * prose. Idempotent per (item, stage, attempt): a retried stage returns the existing packet
 * instead of appending a duplicate event. A missing patch yields zero diff stats; the
 * activity never fails because the run directory was cleaned or the patch is absent.
 */
export async function recordReviewPacket(args: {
  workItemId: string;
  /** Stage the packet belongs to; used with `attempt` for idempotency. */
  stage?: string;
  /** Stage attempt the packet belongs to. */
  attempt?: number;
  riskTier: RiskTier;
  intent: string;
  planRef?: string | null;
  patchRunId?: string | null;
  architectureImpact?: string[];
  openQuestions?: string[];
  reviewerChecklist?: string[];
}): Promise<ReviewPacket> {
  const sql = getSql();
  const workItem = await getWorkItem(sql, args.workItemId);
  if (!workItem) throw new Error(`work item ${args.workItemId} does not exist`);

  const events = await listWorkItemEvents(sql, args.workItemId, 1000);
  const existing = events.find(
    (event) =>
      event.type === 'review.packet' &&
      (args.stage === undefined || event.stage === args.stage) &&
      (args.attempt === undefined || event.payload?.attempt === args.attempt),
  );
  if (existing) {
    return packetFromPayload(existing.payload, {
      riskTier: args.riskTier,
      intent: args.intent,
    });
  }

  let stats: DiffStats = { changedFiles: 0, additions: 0, deletions: 0 };
  if (args.patchRunId) {
    try {
      const patch = await readFile(patchPath(loadConfig().runsDir, args.patchRunId), 'utf8');
      stats = parsePatchStats(patch);
    } catch {
      // Missing/cleaned run directory: the packet still describes the evidence and plan.
    }
  }

  const packet: ReviewPacket = {
    riskTier: args.riskTier,
    intent: args.intent,
    planRef: args.planRef ?? null,
    changedFiles: stats.changedFiles,
    diffStats: { additions: stats.additions, deletions: stats.deletions },
    assertions: assertionsFromWorkItemEvents(events),
    architectureImpact: args.architectureImpact ?? [],
    openQuestions: args.openQuestions ?? [],
    reviewerChecklist: args.reviewerChecklist ?? [...REVIEWER_CHECKLIST],
  };

  await appendWorkItemEvent(sql, {
    workItemId: args.workItemId,
    type: 'review.packet',
    stage: args.stage ?? workItem.stage,
    actor: 'foreman',
    payload: {
      ...packet,
      ...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
    },
  });

  return packet;
}
