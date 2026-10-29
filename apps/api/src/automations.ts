import { z } from 'zod';
import { loadDefinition } from '@factory/core';
import {
  pauseAutomationSchedule,
  syncAutomationSchedules,
  type AutomationSyncResult,
} from '@factory/orchestration';
import type { ApiConfig } from './config';
import { toOrchestrationConfig } from './config';
import { ApiError } from './errors';
import { resolveFactoryDir } from './factories';

/**
 * Automation schedule wiring (spec `automations` › scheduled automations).
 *
 * A definition automation with a `schedule` trigger becomes a Temporal schedule; syncing
 * creates it, keeps its cron in step with git, and pauses it when the automation is
 * disabled. Pausing never creates new work (spec: pause).
 */

export interface AutomationSpecInput {
  name: string;
  enabled: boolean;
  cron: string;
  title?: string;
}

/** Builds the schedule specs from the git-backed definition (the only source of truth). */
export function automationSpecsFromDefinition(dir: string, factory: string): AutomationSpecInput[] {
  const { definition, errors } = loadDefinition(dir);
  if (!definition) {
    throw new ApiError('definition_invalid', 422, `factory "${factory}" does not validate`, {
      factory,
      errors,
    });
  }

  const specs: AutomationSpecInput[] = [];
  for (const resource of definition.resources) {
    if (resource.kind !== 'automation') continue;
    const doc = resource.doc as {
      displayName?: string;
      enabled?: boolean;
      triggers?: { provider: string; schedule?: string }[];
    };
    const cron = (doc.triggers ?? []).find((trigger) => trigger.provider === 'schedule')?.schedule;
    if (!cron) continue;
    specs.push({
      name: resource.name,
      enabled: doc.enabled !== false,
      cron,
      ...(doc.displayName ? { title: doc.displayName } : {}),
    });
  }
  return specs;
}

export async function syncAutomationsForApi(
  config: ApiConfig,
  factory: string,
): Promise<AutomationSyncResult> {
  const dir = resolveFactoryDir(config, factory);
  const specs = automationSpecsFromDefinition(dir, factory);
  return await syncAutomationSchedules(factory, dir, specs, toOrchestrationConfig(config));
}

export const automationPauseBodySchema = z
  .object({ actor: z.string().min(1).max(120), reason: z.string().min(1).max(2000) })
  .strict();

export type AutomationPauseBody = z.infer<typeof automationPauseBodySchema>;

export async function pauseAutomationForApi(
  config: ApiConfig,
  factory: string,
  automation: string,
  body: AutomationPauseBody,
): Promise<{ factory: string; automation: string; status: string }> {
  resolveFactoryDir(config, factory);
  const record = await pauseAutomationSchedule(
    factory,
    automation,
    `${body.reason} (by ${body.actor})`,
    toOrchestrationConfig(config),
  );
  if (!record) {
    throw new ApiError('automation_not_found', 404, `no automation "${automation}" for "${factory}"`, {
      factory,
      automation,
    });
  }
  return { factory, automation, status: record.status };
}
