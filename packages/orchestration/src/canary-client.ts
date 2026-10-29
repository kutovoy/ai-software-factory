import { getClient } from './client';
import { loadConfig, type OrchestrationConfig } from './config';
import type { CanaryDecisionSignal, CanaryWorkflowInput } from './types';
import { canaryWorkflowId } from './types';

/**
 * Canary client (Phase 5b). The API and the improvement workflow start one `CanaryWorkflow`
 * per rollout; the workflow id is derived from the rollout id so a duplicate start cannot
 * observe the same rollout twice.
 *
 * Manual promote/rollback are performed synchronously in the read model (routing stops
 * immediately) and then delivered as a Signal so the workflow stops observing. Delivery is
 * best-effort: the read model is the source of truth, and the workflow also notices a
 * terminal status on its next observation.
 */

export interface StartedCanary {
  workflowId: string;
  temporalRunId: string;
}

export async function startCanaryWorkflow(
  input: CanaryWorkflowInput,
  config: OrchestrationConfig = loadConfig(),
): Promise<StartedCanary> {
  const client = await getClient(config);
  const workflowId = canaryWorkflowId(input.rolloutId);
  const handle = await client.workflow.start('CanaryWorkflow', {
    taskQueue: config.taskQueue,
    workflowId,
    args: [input],
    // The observation window may be days long; the workflow is a durable timer.
    workflowExecutionTimeout: '30 days',
    workflowTaskTimeout: '30 seconds',
  });
  return { workflowId, temporalRunId: handle.firstExecutionRunId };
}

export interface CanarySignalDelivery {
  delivered: boolean;
}

async function signal(
  rolloutId: string,
  name: 'canaryRollback' | 'canaryPromote',
  payload: CanaryDecisionSignal,
  config: OrchestrationConfig,
): Promise<CanarySignalDelivery> {
  try {
    const client = await getClient(config);
    await client.workflow.getHandle(canaryWorkflowId(rolloutId)).signal(name, payload);
    return { delivered: true };
  } catch {
    // The workflow may already be finished; the read model remains the truth.
    return { delivered: false };
  }
}

export async function signalCanaryRollback(
  rolloutId: string,
  payload: CanaryDecisionSignal,
  config: OrchestrationConfig = loadConfig(),
): Promise<CanarySignalDelivery> {
  return await signal(rolloutId, 'canaryRollback', payload, config);
}

export async function signalCanaryPromote(
  rolloutId: string,
  payload: CanaryDecisionSignal,
  config: OrchestrationConfig = loadConfig(),
): Promise<CanarySignalDelivery> {
  return await signal(rolloutId, 'canaryPromote', payload, config);
}

/** Diagnostics only; Postgres remains the read model for the UI. */
export async function describeCanary(
  rolloutId: string,
  config: OrchestrationConfig = loadConfig(),
): Promise<{ status: string; workflowId: string } | null> {
  try {
    const client = await getClient(config);
    const description = await client.workflow.getHandle(canaryWorkflowId(rolloutId)).describe();
    return { status: description.status.name, workflowId: description.workflowId };
  } catch {
    return null;
  }
}
