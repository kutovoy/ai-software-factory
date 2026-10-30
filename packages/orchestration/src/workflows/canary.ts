import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activities from '../activities';
import type {
  CanaryDecisionSignal,
  CanaryObservationSummary,
  CanaryWorkflowInput,
  CanaryWorkflowOutcome,
} from '../types';

/**
 * CanaryWorkflow (Phase 5b, spec `self-improvement` › Canary rollout and rollback, ADR-021).
 *
 * One workflow per rollout: publish the candidate version → open the observation window →
 * compare candidate vs stable scores/incidents → promote or roll back.
 *
 * The window is a durable Temporal timer, so a days-long rollout holds no activity slot.
 * Manual promote/rollback are Signals: the API already finalised the read model (routing
 * stopped immediately), and the Signal only wakes this workflow so it stops observing.
 * Every write is an activity guarded by the rollout status, so a retry is idempotent.
 */

const canary = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
  },
});

const finish = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
});

/** Manual rollback / promotion: the API already finalised the read model. */
export const canaryRollbackSignal = defineSignal<[CanaryDecisionSignal]>('canaryRollback');
export const canaryPromoteSignal = defineSignal<[CanaryDecisionSignal]>('canaryPromote');

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function observationWindowMs(input: CanaryWorkflowInput): number {
  if (typeof input.observationWindowMs === 'number' && input.observationWindowMs > 0) {
    return input.observationWindowMs;
  }
  return Math.max(1, input.observationWindowHours) * 60 * 60 * 1000;
}

function checkIntervalMs(input: CanaryWorkflowInput, windowMs: number): number {
  if (typeof input.checkIntervalMs === 'number' && input.checkIntervalMs > 0) {
    return input.checkIntervalMs;
  }
  // Re-read the metrics ~10 times over the window, but never more often than once a minute.
  return Math.max(60_000, Math.min(15 * 60_000, Math.floor(windowMs / 10)));
}

export async function CanaryWorkflow(input: CanaryWorkflowInput): Promise<CanaryWorkflowOutcome> {
  type Manual = { kind: 'rollback' | 'promote'; actor: string; reason: string };
  let manual: Manual | null = null;
  // Read through a function so TypeScript does not narrow the variable to its initial
  // `null`: the Signal handlers mutate it from a closure.
  const manualNow = (): Manual | null => manual;

  setHandler(canaryRollbackSignal, (signal: CanaryDecisionSignal) => {
    manual ??= { kind: 'rollback', actor: signal.actor, reason: signal.reason };
  });
  setHandler(canaryPromoteSignal, (signal: CanaryDecisionSignal) => {
    manual ??= { kind: 'promote', actor: signal.actor, reason: signal.reason };
  });

  const base: Omit<CanaryWorkflowOutcome, 'status' | 'reason' | 'actor' | 'observation'> = {
    rolloutId: input.rolloutId,
    candidateVersion: input.candidateVersion,
    stableVersion: input.stableVersion,
  };

  let observation: CanaryObservationSummary | null = null;

  try {
    await canary.publishCanaryCandidateActivity({ input });
  } catch (error) {
    const reason = `publish_failed: ${message(error)}`;
    await finish
      .failCanaryActivity({ rolloutId: input.rolloutId, factory: input.factory, reason })
      .catch(() => undefined);
    return {
      ...base,
      status: 'unavailable',
      reason,
      actor: input.actor,
      observation: null,
    };
  }

  const windowMs = observationWindowMs(input);
  const pollMs = checkIntervalMs(input, windowMs);
  const deadline = Date.now() + windowMs;

  for (;;) {
    observation = await canary.observeCanaryActivity({ input });

    // The API may have finalised the rollout without the Signal reaching us.
    if (observation.status !== 'active') {
      return {
        ...base,
        status: observation.status === 'promoted' ? 'promoted' : 'rolled_back',
        reason: observation.reason ?? observation.status,
        // A manual decision finalised by the API is recorded in the evidence; report that
        // actor rather than the rollout's start actor (flake: Signal vs observation race).
        actor: observation.actor ?? input.actor,
        observation,
      };
    }

    if (observation.regressionExceeded) {
      const reason = observation.regressionReason ?? 'regression_exceeded';
      await finish.rollbackCanaryActivity({
        input,
        actor: 'canary-observer',
        reason: `${reason}: ${observation.detail}`,
        observation,
        automatic: true,
      });
      return {
        ...base,
        status: 'rolled_back',
        reason,
        actor: 'canary-observer',
        observation,
      };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (manualNow()) break;

    // `condition` returns as soon as a manual Signal arrives; otherwise it is a durable
    // timer for the next observation tick.
    await condition(() => manual !== null, Math.min(pollMs, remaining));
    if (manualNow()) break;
  }

  const decided = manualNow();
  if (decided?.kind === 'rollback') {
    // The API already rolled back; the activity is idempotent and returns the terminal row.
    await finish.rollbackCanaryActivity({
      input,
      actor: decided.actor,
      reason: decided.reason,
      observation,
      automatic: false,
    });
    return {
      ...base,
      status: 'rolled_back',
      reason: decided.reason,
      actor: decided.actor,
      observation,
    };
  }

  const actor = decided?.kind === 'promote' ? decided.actor : 'canary-observer';
  const reason = decided?.kind === 'promote'
    ? decided.reason
    : observation?.insufficientData
      ? 'observation window elapsed with no candidate evidence'
      : 'observation window elapsed with no regression beyond the threshold';

  try {
    const promoted = await finish.promoteCanaryActivity({
      input,
      actor,
      reason,
      observation,
      automatic: manual === null,
    });
    return {
      ...base,
      status: 'promoted',
      reason: promoted.rollout.reason ?? reason,
      actor,
      observation,
      promotedCommit: promoted.mergedCommit ?? null,
      prUrl: promoted.rollout.prUrl,
      prNumber: promoted.rollout.prNumber,
    };
  } catch (error) {
    // A promotion that cannot merge (red checks, forge failure) must not become stable:
    // roll back instead of leaving a half-promoted rollout.
    const detail = `promotion_failed: ${message(error)}`;
    await finish
      .rollbackCanaryActivity({
        input,
        actor: 'canary-observer',
        reason: detail,
        observation,
        automatic: true,
      })
      .catch(() => undefined);
    return {
      ...base,
      status: 'rolled_back',
      reason: detail,
      actor: 'canary-observer',
      observation,
    };
  }
}
