import { ApplicationFailure } from '@temporalio/activity';
import {
  getCanaryRollout,
  updateCanaryRollout,
  type CanaryRolloutRecord,
} from '@factory/core';
import { getSql } from '../db';
import { readCanaryObservation } from '../canary-metrics';
import {
  promoteCanaryRollout,
  publishCanaryCandidate,
  rollbackCanaryRollout,
  type CanaryFinishResult,
  type PublishedCanaryCandidate,
} from '../canary-apply';
import type { CanaryObservationSummary, CanaryWorkflowInput } from '../types';

/**
 * Canary activities (Phase 5b, ADR-021).
 *
 * The workflow itself is deterministic and holds no I/O: publishing, observing and
 * finishing are activities, so a retry resumes at the last durable boundary. Every write is
 * guarded by the rollout status (pending → active → promoted/rolled_back), so a retried
 * activity never duplicates a candidate commit, a merge or an audit event.
 */

function fail(code: string, message: string, details?: unknown, nonRetryable = true): never {
  throw ApplicationFailure.create({
    type: code,
    nonRetryable,
    message,
    ...(details === undefined ? {} : { details: [details] }),
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function coded(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'canary_error';
}

export async function publishCanaryCandidateActivity(args: {
  input: CanaryWorkflowInput;
}): Promise<PublishedCanaryCandidate> {
  try {
    return await publishCanaryCandidate(args.input);
  } catch (error) {
    fail(coded(error), message(error), { rolloutId: args.input.rolloutId });
  }
}

/** Reads the current rollout + the metrics over the window so far. */
export async function observeCanaryActivity(args: {
  input: CanaryWorkflowInput;
}): Promise<CanaryObservationSummary> {
  const sql = getSql();
  const rollout = await getCanaryRollout(sql, args.input.rolloutId);
  if (!rollout) {
    fail('canary_not_found', `rollout "${args.input.rolloutId}" does not exist`, {
      rolloutId: args.input.rolloutId,
    });
  }

  const observation = await readCanaryObservation({
    factory: rollout.factory,
    rolloutId: rollout.id,
    stableCommit: rollout.stableCommit ?? args.input.stableCommit,
    candidateCommit: rollout.candidateCommit,
    startedAt: rollout.startedAt,
    until: rollout.endedAt,
    rollbackThreshold: rollout.rollbackThreshold,
    canaryPercent: rollout.canaryPercent,
    observationWindowHours: rollout.observationWindowHours,
  });

  return {
    ...observation,
    status: rollout.status,
    reason: rollout.reason,
    startedAt: rollout.startedAt,
    endedAt: rollout.endedAt,
  };
}

export interface CanaryFinishActivityResult {
  rollout: CanaryRolloutRecord;
  changed: boolean;
  mergedCommit?: string | null;
}

export async function promoteCanaryActivity(args: {
  input: CanaryWorkflowInput;
  actor: string;
  reason: string;
  observation?: CanaryObservationSummary | null;
  automatic?: boolean;
}): Promise<CanaryFinishActivityResult> {
  try {
    const result: CanaryFinishResult = await promoteCanaryRollout({
      rolloutId: args.input.rolloutId,
      factory: args.input.factory,
      actor: args.actor,
      reason: args.reason,
      observation: args.observation ?? null,
      automatic: args.automatic ?? false,
    });
    return result;
  } catch (error) {
    fail(coded(error), message(error), { rolloutId: args.input.rolloutId });
  }
}

export async function rollbackCanaryActivity(args: {
  input: CanaryWorkflowInput;
  actor: string;
  reason: string;
  observation?: CanaryObservationSummary | null;
  automatic?: boolean;
}): Promise<CanaryFinishActivityResult> {
  try {
    return await rollbackCanaryRollout({
      rolloutId: args.input.rolloutId,
      factory: args.input.factory,
      actor: args.actor,
      reason: args.reason,
      observation: args.observation ?? null,
      automatic: args.automatic ?? false,
    });
  } catch (error) {
    fail(coded(error), message(error), { rolloutId: args.input.rolloutId });
  }
}

/**
 * Marks a rollout that could not publish as `unavailable`. Routing never started, so this
 * is not a rollback; the proposal is left as `canary` with the failure reason recorded.
 */
export async function failCanaryActivity(args: {
  rolloutId: string;
  factory: string;
  reason: string;
}): Promise<CanaryRolloutRecord | null> {
  const sql = getSql();
  return await updateCanaryRollout(sql, {
    id: args.rolloutId,
    from: ['pending', 'active'],
    status: 'unavailable',
    reason: args.reason,
    ended: true,
  });
}
