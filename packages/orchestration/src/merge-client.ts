import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/client';
import { getClient } from './client';
import { loadConfig, type OrchestrationConfig } from './config';
import type { MergeQueueWorkflowInput, MergeRevertWorkflowInput } from './types';
import { mergeQueueWorkflowId, mergeRevertWorkflowId } from './types';

/**
 * Merge queue client. There is exactly one queue per factory: starting it again attaches to
 * the running workflow (`USE_EXISTING`) instead of creating a second batch loop, which is
 * what "at most one merge batch in flight" means at the orchestration level.
 */

export interface MergeQueueStart {
  workflowId: string;
  /** False when a queue run was already in flight and this call only attached to it. */
  started: boolean;
  temporalRunId: string | null;
}

export async function ensureMergeQueueWorkflow(
  input: MergeQueueWorkflowInput,
  config: OrchestrationConfig = loadConfig(),
): Promise<MergeQueueStart> {
  const client = await getClient(config);
  const workflowId = mergeQueueWorkflowId(input.factory);
  try {
    const handle = await client.workflow.start('MergeQueueWorkflow', {
      taskQueue: config.taskQueue,
      workflowId,
      args: [input],
      workflowExecutionTimeout: '30 days',
      workflowTaskTimeout: '30 seconds',
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
    });
    return { workflowId, started: true, temporalRunId: handle.firstExecutionRunId ?? null };
  } catch {
    // A queue run is already in flight (or the server rejected the duplicate); the
    // enqueued row is picked up by the running loop on its next plan call.
    return { workflowId, started: false, temporalRunId: null };
  }
}

/** Diagnostics only; Postgres remains the read model for the UI. */
export async function describeMergeQueue(
  factory: string,
  config: OrchestrationConfig = loadConfig(),
): Promise<{ status: string; workflowId: string } | null> {
  try {
    const client = await getClient(config);
    const description = await client.workflow.getHandle(mergeQueueWorkflowId(factory)).describe();
    return { status: description.status.name, workflowId: description.workflowId };
  } catch {
    return null;
  }
}

/** Starts the one-shot revert workflow; the read model flips when the worker finishes. */
export async function startMergeRevert(
  input: MergeRevertWorkflowInput,
  config: OrchestrationConfig = loadConfig(),
): Promise<{ workflowId: string; temporalRunId: string }> {
  const client = await getClient(config);
  const workflowId = mergeRevertWorkflowId(input.batchId, new Date().toISOString());
  const handle = await client.workflow.start('MergeRevertWorkflow', {
    taskQueue: config.taskQueue,
    workflowId,
    args: [input],
    workflowExecutionTimeout: '1 hour',
    workflowTaskTimeout: '30 seconds',
  });
  return { workflowId, temporalRunId: handle.firstExecutionRunId };
}
