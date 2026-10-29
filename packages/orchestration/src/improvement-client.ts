import { getClient } from './client';
import { loadConfig, type OrchestrationConfig } from './config';
import type { ImprovementWorkflowInput } from './types';
import { improvementWorkflowId } from './types';

/**
 * Improvement client. The API starts one `ImprovementWorkflow` per run through this
 * module; the workflow id is derived from the run id, so a duplicate start is rejected
 * instead of observing the same corpus twice.
 */

export interface StartedImprovement {
  workflowId: string;
  temporalRunId: string;
}

export async function startImprovementWorkflow(
  input: ImprovementWorkflowInput,
  config: OrchestrationConfig = loadConfig(),
): Promise<StartedImprovement> {
  const client = await getClient(config);
  const workflowId = improvementWorkflowId(input.improvementRunId);
  const handle = await client.workflow.start('ImprovementWorkflow', {
    taskQueue: config.taskQueue,
    workflowId,
    args: [input],
    workflowExecutionTimeout: '2 hours',
    workflowTaskTimeout: '30 seconds',
  });
  return { workflowId, temporalRunId: handle.firstExecutionRunId };
}

/** Diagnostics only; Postgres remains the read model for the UI. */
export async function describeImprovement(
  improvementRunId: string,
  config: OrchestrationConfig = loadConfig(),
): Promise<{ status: string; workflowId: string } | null> {
  try {
    const client = await getClient(config);
    const description = await client.workflow
      .getHandle(improvementWorkflowId(improvementRunId))
      .describe();
    return { status: description.status.name, workflowId: description.workflowId };
  } catch {
    return null;
  }
}
