import { ScheduleOverlapPolicy } from '@temporalio/client';
import {
  automationScheduleId,
  getAutomationSchedule,
  listAutomationSchedules,
  upsertAutomationSchedule,
  type AutomationScheduleRecord,
} from '@factory/core';
import { getClient } from './client';
import { loadConfig, type OrchestrationConfig } from './config';
import { getSql } from './db';
import type { AutomationWorkflowInput } from './types';

/**
 * Automation schedules (spec `automations` › scheduled automations, design decision 7).
 *
 * A definition automation with a `schedule` trigger becomes a Temporal schedule. Enabling an
 * automation creates (or resumes) it; disabling it pauses the schedule so no new work items
 * appear. The Postgres row is the projection the console reads (status + last fire).
 */

export interface AutomationSpec {
  name: string;
  enabled: boolean;
  cron: string;
  title?: string;
  prompt?: string;
  harness?: AutomationWorkflowInput['harness'];
  model?: string;
  runner?: AutomationWorkflowInput['runner'];
}

export interface AutomationSyncResult {
  factory: string;
  created: string[];
  updated: string[];
  paused: string[];
  active: string[];
  schedules: AutomationScheduleRecord[];
}

export function temporalScheduleIdFor(factory: string, automation: string): string {
  return `automation-${factory}-${automation}`;
}

export async function syncAutomationSchedules(
  factory: string,
  factoryRoot: string,
  specs: AutomationSpec[],
  config: OrchestrationConfig = loadConfig(),
): Promise<AutomationSyncResult> {
  const sql = getSql();
  const client = await getClient(config);
  const created: string[] = [];
  const updated: string[] = [];
  const paused: string[] = [];
  const active: string[] = [];

  for (const spec of specs) {
    const rowId = automationScheduleId(factory, spec.name);
    const scheduleId = temporalScheduleIdFor(factory, spec.name);
    const existingRow = await getAutomationSchedule(sql, factory, spec.name);

    if (!spec.enabled) {
      try {
        const handle = client.schedule.getHandle(scheduleId);
        await handle.describe();
        await handle.pause(`automation "${spec.name}" is disabled in the definition`);
        paused.push(scheduleId);
      } catch {
        // No schedule yet: nothing to pause.
      }
      await upsertAutomationSchedule(sql, {
        factory,
        automation: spec.name,
        kind: 'cron',
        cron: spec.cron,
        status: 'paused',
        temporalScheduleId: scheduleId,
      });
      continue;
    }

    const args: AutomationWorkflowInput = {
      factory,
      factoryRoot,
      automation: spec.name,
      scheduleId: rowId,
      cron: spec.cron,
      ...(spec.title ? { title: spec.title } : {}),
      ...(spec.prompt ? { prompt: spec.prompt } : {}),
      ...(spec.harness ? { harness: spec.harness } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.runner ? { runner: spec.runner } : {}),
    };

    let exists = false;
    try {
      const handle = client.schedule.getHandle(scheduleId);
      const description = await handle.describe();
      exists = true;

      if (description.state.paused) {
        await handle.unpause();
      }
      // Keep the cron in sync with the definition (a changed schedule is a definition change).
      // The Temporal `describe()` spec is a human-readable description, so the projection
      // row is the source of the cron we last installed.
      if (existingRow?.cron !== undefined && existingRow.cron !== spec.cron) {
        await handle.update((previous) => ({
          spec: { cronExpressions: [spec.cron] },
          action: previous.action,
          policies: previous.policies,
          state: { paused: previous.state.paused, note: previous.state.note ?? '' },
        }));
        updated.push(scheduleId);
      }
      active.push(scheduleId);
    } catch {
      // Not found: create below.
    }

    if (!exists) {
      await client.schedule.create({
        scheduleId,
        spec: { cronExpressions: [spec.cron] },
        action: {
          type: 'startWorkflow',
          workflowType: 'AutomationWorkflow',
          taskQueue: config.taskQueue,
          workflowExecutionTimeout: '1 hour',
          workflowTaskTimeout: '30 seconds',
          args: [args],
        },
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
      });
      created.push(scheduleId);
      active.push(scheduleId);
    }

    await upsertAutomationSchedule(sql, {
      factory,
      automation: spec.name,
      kind: 'cron',
      cron: spec.cron,
      status: 'active',
      temporalScheduleId: scheduleId,
    });
  }

  return {
    factory,
    created,
    updated,
    paused,
    active,
    schedules: await listAutomationSchedules(sql, factory),
  };
}

/** Pauses one automation (kill switch for a single schedule). */
export async function pauseAutomationSchedule(
  factory: string,
  automation: string,
  reason: string,
  config: OrchestrationConfig = loadConfig(),
): Promise<AutomationScheduleRecord | null> {
  const sql = getSql();
  const client = await getClient(config);
  const scheduleId = temporalScheduleIdFor(factory, automation);
  try {
    await client.schedule.getHandle(scheduleId).pause(reason);
  } catch {
    // A missing schedule is fine: the projection below records the intent.
  }
  const existing = await getAutomationSchedule(sql, factory, automation);
  return await upsertAutomationSchedule(sql, {
    factory,
    automation,
    kind: existing?.kind ?? 'cron',
    cron: existing?.cron ?? null,
    status: 'paused',
    temporalScheduleId: scheduleId,
  });
}

/** Diagnostics only; Postgres remains the read model. */
export async function describeAutomationSchedule(
  factory: string,
  automation: string,
  config: OrchestrationConfig = loadConfig(),
): Promise<{ paused: boolean; nextActionAt: string | null; scheduleId: string } | null> {
  try {
    const client = await getClient(config);
    const scheduleId = temporalScheduleIdFor(factory, automation);
    const description = await client.schedule.getHandle(scheduleId).describe();
    return {
      paused: description.state.paused,
      nextActionAt: description.info.nextActionTimes[0]?.toISOString() ?? null,
      scheduleId,
    };
  } catch {
    return null;
  }
}
