import {
  appendWorkItemEvent,
  attachPullRequest,
  getAutonomyState,
  getWorkItemCancel,
  markWorkItemCancelled,
  recordGateDecision,
  requestGateDecision,
  setWorkItemStatus,
  transitionWorkItem,
  type AgentVerdict,
  type AutonomyState,
  type GateDecisionValue,
  type LoopStage,
  type WorkItemCancelState,
  type WorkItemStatus,
} from '@factory/core';
import { getSql } from '../db';

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
