import { loadConfig, type OrchestrationConfig } from './config';
import { getClient } from './client';
import type {
  AutonomyPausedSignal,
  FactoryWorkflowInput,
  GateDecisionAck,
  GateDecisionInput,
  GateDecisionValue,
  LoopStageName,
  StageWorkflowInput,
  StageWorkflowResult,
} from './types';
import { stageWorkflowId, workItemWorkflowId } from './types';

/**
 * Client helpers for the factory loop. The API starts work-item workflows and delivers
 * gate decisions through this module only; it never talks to a harness, runner or forge.
 */

export interface StartedWorkItem {
  workflowId: string;
  temporalRunId: string;
}

/** Starts one `FactoryWorkflow` per work item; the id is derived from the item id. */
export async function startFactoryWorkflow(
  input: FactoryWorkflowInput,
  config: OrchestrationConfig = loadConfig(),
): Promise<StartedWorkItem> {
  const client = await getClient(config);
  const workflowId = workItemWorkflowId(input.workItemId, input.attempt ?? 1);
  const handle = await client.workflow.start('FactoryWorkflow', {
    taskQueue: config.taskQueue,
    workflowId,
    args: [input],
    workflowExecutionTimeout: '30 days',
    workflowTaskTimeout: '30 seconds',
  });
  return { workflowId, temporalRunId: handle.firstExecutionRunId };
}

export interface GateDecisionDelivery {
  delivered: 'update' | 'signal';
  accepted: boolean;
}

/**
 * Delivers a gate decision to the waiting stage child (ADR-013 pattern).
 *
 * Preferred channel is the `submitGateDecision` Update (synchronous ack). If the child
 * cannot take an Update (e.g. it already finished or the workflow is older), we fall back
 * to the equivalent `gateDecision` Signal on the same workflow id.
 */
export async function submitGateDecision(
  input: {
    workflowId: string;
    stage: LoopStageName;
    decision: GateDecisionValue;
    actor: string;
    reason?: string;
    feedback?: string;
    attempt?: number;
  },
  config: OrchestrationConfig = loadConfig(),
): Promise<GateDecisionDelivery> {
  const client = await getClient(config);
  const handle = client.workflow.getHandle(input.workflowId);
  const payload: GateDecisionInput = {
    stage: input.stage,
    decision: input.decision,
    actor: input.actor,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.feedback ? { feedback: input.feedback } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
  };

  try {
    const ack = await handle.executeUpdate<GateDecisionAck, [GateDecisionInput]>(
      'submitGateDecision',
      { args: [payload] },
    );
    return { delivered: 'update', accepted: ack?.accepted !== false };
  } catch {
    await handle.signal('gateDecision', payload);
    return { delivered: 'signal', accepted: true };
  }
}

/** Kill switch: stops new stage dispatch for one work item. */
export async function pauseWorkItemAutonomy(
  input: { workflowId: string } & AutonomyPausedSignal,
  config: OrchestrationConfig = loadConfig(),
): Promise<void> {
  const client = await getClient(config);
  await client.workflow
    .getHandle(input.workflowId)
    .signal('autonomyPaused', { actor: input.actor, reason: input.reason });
}

/** Graceful cancellation of a work item (best effort; the read model is the truth). */
export async function cancelWorkItem(
  workflowId: string,
  payload: { actor: string; reason: string },
  config: OrchestrationConfig = loadConfig(),
): Promise<{ delivered: boolean }> {
  try {
    const client = await getClient(config);
    await client.workflow
      .getHandle(workflowId)
      .signal('cancelWorkItem', { actor: payload.actor, reason: payload.reason });
    return { delivered: true };
  } catch {
    // The workflow may already be finished; the read model + pre-dispatch read remain
    // the truth, so a lost Signal does not resurrect the item.
    return { delivered: false };
  }
}

/** Diagnostics only; Postgres remains the read model for the UI. */
export async function describeWorkItem(
  workItemId: string,
  config: OrchestrationConfig = loadConfig(),
): Promise<{ status: string; workflowId: string } | null> {
  try {
    const client = await getClient(config);
    const description = await client.workflow
      .getHandle(workItemWorkflowId(workItemId))
      .describe();
    return { status: description.status.name, workflowId: description.workflowId };
  } catch {
    return null;
  }
}

/** Convenience for tests: start a single stage child (review fan-out / gate-only). */
export async function startStageWorkflow(
  input: StageWorkflowInput,
  suffix: string | undefined,
  config: OrchestrationConfig = loadConfig(),
): Promise<{ workflowId: string; result: () => Promise<StageWorkflowResult> }> {
  const client = await getClient(config);
  const workflowId = stageWorkflowId(
    input.workItemId,
    input.stage,
    input.attempt,
    suffix,
  );
  const handle = await client.workflow.start('StageWorkflow', {
    taskQueue: config.taskQueue,
    workflowId,
    args: [input],
    workflowExecutionTimeout: '7 days',
    workflowTaskTimeout: '30 seconds',
  });
  return { workflowId, result: () => handle.result() as Promise<StageWorkflowResult> };
}
