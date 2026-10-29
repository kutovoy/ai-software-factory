import { join } from 'node:path';
import { ScheduleOverlapPolicy } from '@temporalio/client';
import { getClient } from './client';
import { loadConfig, type OrchestrationConfig } from './config';
import type { ScoringWorkflowInput } from './types';

/**
 * Scoring client. The API starts on-demand scoring through this module; the worker runs
 * the workflow. Scheduled scoring is a Temporal Schedule per factory, created once.
 */

export interface StartedScoring {
  workflowId: string;
  temporalRunId: string;
}

export function scoringWorkflowId(factory: string, trigger: string): string {
  return `scoring-${factory}-${trigger}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export async function startScoringWorkflow(
  input: ScoringWorkflowInput,
  config: OrchestrationConfig = loadConfig(),
): Promise<StartedScoring> {
  const client = await getClient(config);
  const workflowId = scoringWorkflowId(input.factory, input.trigger);
  const handle = await client.workflow.start('ScoringWorkflow', {
    taskQueue: config.taskQueue,
    workflowId,
    args: [input],
    workflowExecutionTimeout: '1 hour',
    workflowTaskTimeout: '30 seconds',
  });
  return { workflowId, temporalRunId: handle.firstExecutionRunId };
}

/**
 * Creates (idempotently) one scoring schedule per factory. Existing schedules are left
 * untouched so a restart never rewrites the cron a human configured.
 */
export async function ensureScoringSchedule(
  config: OrchestrationConfig = loadConfig(),
  factories: string[],
): Promise<{ created: string[]; existing: string[] }> {
  const client = await getClient(config);
  const created: string[] = [];
  const existing: string[] = [];

  for (const factory of factories) {
    const scheduleId = `scoring-${factory}`;
    try {
      await client.schedule.getHandle(scheduleId).describe();
      existing.push(scheduleId);
      continue;
    } catch {
      // not found: create below
    }

    await client.schedule.create({
      scheduleId,
      spec: { cronExpressions: [config.scoringCron] },
      action: {
        type: 'startWorkflow',
        workflowType: 'ScoringWorkflow',
        taskQueue: config.taskQueue,
        workflowExecutionTimeout: '1 hour',
        workflowTaskTimeout: '30 seconds',
        args: [
          {
            factory,
            factoryRoot: join(config.factoryRoot, factory),
            trigger: 'scheduled',
            windowDays: config.scoringWindowDays,
          } satisfies ScoringWorkflowInput,
        ],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
    });
    created.push(scheduleId);
  }

  return { created, existing };
}
