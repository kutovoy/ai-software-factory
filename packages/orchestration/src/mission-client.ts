import { loadConfig, type OrchestrationConfig } from './config';
import { getClient } from './client';
import type {
  MissionPlanDecisionAck,
  MissionPlanDecisionInput,
  MissionWorkflowInput,
} from './types';
import { missionWorkflowId } from './types';

/**
 * Client helpers for long-running missions. The API starts mission workflows and delivers
 * plan decisions / controls through this module; it never talks to a harness or runner.
 */

export interface StartedMission {
  workflowId: string;
  temporalRunId: string;
}

export async function startMissionWorkflow(
  input: MissionWorkflowInput,
  config: OrchestrationConfig = loadConfig(),
): Promise<StartedMission> {
  const client = await getClient(config);
  const workflowId = missionWorkflowId(input.missionId, input.attempt ?? 1);
  const handle = await client.workflow.start('MissionWorkflow', {
    taskQueue: config.taskQueue,
    workflowId,
    args: [input],
    workflowExecutionTimeout: '365 days',
    workflowTaskTimeout: '30 seconds',
  });
  return { workflowId, temporalRunId: handle.firstExecutionRunId };
}

export interface MissionDecisionDelivery {
  delivered: 'update' | 'signal';
  accepted: boolean;
}

/** Preferred channel: a Temporal Update with a synchronous acknowledgement. */
export async function submitMissionPlanDecision(
  input: { workflowId: string } & MissionPlanDecisionInput,
  config: OrchestrationConfig = loadConfig(),
): Promise<MissionDecisionDelivery> {
  const client = await getClient(config);
  const handle = client.workflow.getHandle(input.workflowId);
  const payload: MissionPlanDecisionInput = {
    decision: input.decision,
    actor: input.actor,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.feedback ? { feedback: input.feedback } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
  };

  try {
    const ack = await handle.executeUpdate<MissionPlanDecisionAck, [MissionPlanDecisionInput]>(
      'submitMissionPlanDecision',
      { args: [payload] },
    );
    return { delivered: 'update', accepted: ack?.accepted !== false };
  } catch {
    await handle.signal('missionPlanDecision', payload);
    return { delivered: 'signal', accepted: true };
  }
}

export async function pauseMission(
  workflowId: string,
  payload: { actor: string; reason?: string },
  config: OrchestrationConfig = loadConfig(),
): Promise<{ delivered: boolean }> {
  try {
    const client = await getClient(config);
    await client.workflow.getHandle(workflowId).signal('missionPause', payload);
    return { delivered: true };
  } catch {
    return { delivered: false };
  }
}

export async function resumeMission(
  workflowId: string,
  payload: { actor: string; reason?: string },
  config: OrchestrationConfig = loadConfig(),
): Promise<{ delivered: boolean }> {
  try {
    const client = await getClient(config);
    await client.workflow.getHandle(workflowId).signal('missionResume', payload);
    return { delivered: true };
  } catch {
    return { delivered: false };
  }
}

export async function cancelMission(
  workflowId: string,
  payload: { actor: string; reason: string },
  config: OrchestrationConfig = loadConfig(),
): Promise<{ delivered: boolean }> {
  try {
    const client = await getClient(config);
    await client.workflow.getHandle(workflowId).signal('missionCancel', payload);
    return { delivered: true };
  } catch {
    return { delivered: false };
  }
}

/** Diagnostics only; Postgres remains the read model for the UI. */
export async function describeMission(
  workflowId: string,
  config: OrchestrationConfig = loadConfig(),
): Promise<{ status: string; workflowId: string } | null> {
  try {
    const client = await getClient(config);
    const description = await client.workflow.getHandle(workflowId).describe();
    return { status: description.status.name, workflowId: description.workflowId };
  } catch {
    return null;
  }
}
