import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';
import type { MergeRevertWorkflowInput, MergeRevertWorkflowOutcome } from '../types';

/**
 * MergeRevertWorkflow (spec `merge-queue` › manual revert).
 *
 * A human revert runs where the forge lives — the worker — not in the API process, so the
 * revert is a one-shot workflow: the API starts it, the projection flips to `reverted`, and
 * the action is audited with the actor + reason (ADR-022).
 */

const merge = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
});

export async function MergeRevertWorkflow(
  input: MergeRevertWorkflowInput,
): Promise<MergeRevertWorkflowOutcome> {
  try {
    const result = await merge.revertMergeBatchActivity({
      factory: input.factory,
      batchId: input.batchId,
      actor: input.actor,
      reason: input.reason,
    });
    return {
      factory: input.factory,
      batchId: result.batchId,
      status: result.status,
      sha: result.sha,
      prs: result.prs,
    };
  } catch (error) {
    return {
      factory: input.factory,
      batchId: input.batchId,
      status: 'failed',
      sha: null,
      prs: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
