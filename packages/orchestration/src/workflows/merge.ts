import { proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from '../activities';
import type { MergeQueueBatchOutcome, MergeQueueWorkflowInput, MergeQueueWorkflowOutcome } from '../types';
import { mergeQueueWorkflowId } from '../types';

/**
 * MergeQueueWorkflow (spec `merge-queue`, ADR-022).
 *
 * One workflow per factory, serialized: it claims a batch, merges it, gates the merged
 * stack, bisects or reverts on red, then moves to the next batch. A second start for the
 * same factory attaches to this run (`USE_EXISTING`), so two batches can never be in flight.
 *
 * When the queue is empty the workflow waits `idleIntervalMs` (a durable timer) for new
 * work before completing; a later enqueue starts a fresh run.
 */

const merge = proxyActivities<typeof activities>({
  // Merging + gating a stack can take a while: checks may run for minutes.
  startToCloseTimeout: '30 minutes',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
    maximumAttempts: 3,
  },
});

export async function MergeQueueWorkflow(
  input: MergeQueueWorkflowInput,
): Promise<MergeQueueWorkflowOutcome> {
  const batches: MergeQueueBatchOutcome[] = [];
  const workflowId = mergeQueueWorkflowId(input.factory);
  const maxIdleCycles = input.maxIdleCycles ?? 0;

  try {
    let idle = 0;
    for (let index = 0; index < input.maxBatches; index += 1) {
      const plan = await merge.planMergeBatchActivity({
        factory: input.factory,
        repo: input.repo,
        batchSize: input.batchSize,
        workflowId,
      });

      if (!plan.batchId) {
        idle += 1;
        if (!input.idleIntervalMs || idle > maxIdleCycles) break;
        await sleep(input.idleIntervalMs);
        continue;
      }

      idle = 0;
      const result = await merge.executeMergeBatchActivity({
        factory: input.factory,
        batchId: plan.batchId,
        batchSize: input.batchSize,
        checksTimeoutMs: input.checksTimeoutMs,
        pollIntervalMs: input.pollIntervalMs,
      });
      batches.push(result);
    }

    return { factory: input.factory, batches, completed: true };
  } catch (error) {
    return {
      factory: input.factory,
      batches,
      completed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
