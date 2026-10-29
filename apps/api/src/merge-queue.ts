import { z } from 'zod';
import { getMergeBatch, getMergeQueueView, listWebhookDeliveries } from '@factory/core';
import {
  describeMergeQueue,
  getSql,
  listAutomationSchedulesForApi,
  startMergeRevert,
} from '@factory/orchestration';
import type { ApiConfig } from './config';
import { toOrchestrationConfig } from './config';
import { ApiError, invalidRequest } from './errors';
import { resolveFactoryDir } from './factories';
import { log } from './logger';

/**
 * Merge queue projection (spec `merge-queue`, ADR-022).
 *
 * The console reads batches, items and audit events from Postgres; the workflow status is
 * diagnostics only. A manual revert is a one-shot workflow in the worker (the forge lives
 * there), so the API returns as soon as it is queued and the projection flips when it lands.
 */

export async function getMergeQueueForApi(
  config: ApiConfig,
  factory: string,
): Promise<{
  factory: string;
  batchSize: number;
  checksTimeoutMs: number;
  inFlight: Awaited<ReturnType<typeof getMergeQueueView>>['inFlight'];
  queued: Awaited<ReturnType<typeof getMergeQueueView>>['queued'];
  batches: Awaited<ReturnType<typeof getMergeQueueView>>['batches'];
  workflow: { status: string; workflowId: string } | null;
}> {
  resolveFactoryDir(config, factory);
  const view = await getMergeQueueView(getSql(), factory, 10);
  const workflow = await describeMergeQueue(factory, toOrchestrationConfig(config));
  return {
    factory,
    batchSize: config.mergeBatchSize,
    checksTimeoutMs: config.mergeChecksTimeoutMs,
    inFlight: view.inFlight,
    queued: view.queued,
    batches: view.batches,
    workflow,
  };
}

export const mergeRevertBodySchema = z
  .object({
    factory: z.string().min(1),
    batchId: z.string().min(1).max(120),
    actor: z.string().min(1).max(120),
    reason: z.string().min(1).max(2000),
  })
  .strict();

export type MergeRevertBody = z.infer<typeof mergeRevertBodySchema>;

export interface MergeRevertResult {
  factory: string;
  batchId: string;
  /** `queued` — the revert workflow has been started; the projection flips when it runs. */
  status: 'queued';
  workflow: { workflowId: string; temporalRunId: string };
}

export async function revertMergeBatchForApi(
  config: ApiConfig,
  body: MergeRevertBody,
): Promise<MergeRevertResult> {
  resolveFactoryDir(config, body.factory);
  const batch = await getMergeBatch(getSql(), body.batchId);
  if (!batch || batch.factory !== body.factory) {
    throw new ApiError('merge_batch_not_found', 404, `no merge batch "${body.batchId}" for "${body.factory}"`, {
      factory: body.factory,
      batchId: body.batchId,
    });
  }
  if (batch.status === 'reverted') {
    throw new ApiError('merge_batch_already_reverted', 409, 'the batch is already reverted', {
      factory: body.factory,
      batchId: body.batchId,
    });
  }
  if (batch.status === 'queued' || batch.status === 'merging' || batch.status === 'verifying') {
    throw invalidRequest('the batch is still in flight; wait for it to finish before reverting', {
      batchId: body.batchId,
      status: batch.status,
    });
  }

  const workflow = await startMergeRevert(
    { factory: body.factory, batchId: body.batchId, actor: body.actor, reason: body.reason },
    toOrchestrationConfig(config),
  );

  log('info', 'merge_revert_requested', {
    factory: body.factory,
    batchId: body.batchId,
    actor: body.actor,
    reason: body.reason,
    workflowId: workflow.workflowId,
  });

  return { factory: body.factory, batchId: body.batchId, status: 'queued', workflow };
}

/* ------------------------------------------------------------ automations */

export interface AutomationView {
  name: string;
  displayName: string;
  enabled: boolean;
  agent: string | null;
  cron: string | null;
  webhookEvents: string[];
  schedule: {
    status: string;
    temporalScheduleId: string | null;
    cron: string | null;
    lastFireAt: string | null;
    lastWorkItemId: string | null;
    fireCount: number;
    lastError: string | null;
  } | null;
  webhook: {
    deliveries: number;
    accepted: number;
    ignored: number;
    lastDeliveryAt: string | null;
    lastWorkItemId: string | null;
  };
}

export interface AutomationsResponse {
  factory: string;
  automations: AutomationView[];
  webhook: { url: string; secretRef: string | null };
  schedules: Awaited<ReturnType<typeof listAutomationSchedulesForApi>>;
}

export async function getAutomationsForApi(
  config: ApiConfig,
  factory: string,
): Promise<AutomationsResponse> {
  const dir = resolveFactoryDir(config, factory);
  const { loadDefinition } = await import('@factory/core');
  const { definition, errors } = loadDefinition(dir);
  if (!definition) {
    throw new ApiError('definition_invalid', 422, `factory "${factory}" does not validate`, {
      factory,
      errors,
    });
  }

  const schedules = await listAutomationSchedulesForApi(factory);
  const deliveries = await listWebhookDeliveries(getSql(), { factory, provider: 'github', limit: 200 });
  const { getIntegration } = await import('@factory/core');
  const integration = await getIntegration(getSql(), factory, 'github');

  const automations: AutomationView[] = definition.resources
    .filter((resource) => resource.kind === 'automation')
    .map((resource) => {
      const doc = resource.doc as {
        displayName?: string;
        enabled?: boolean;
        agent?: string;
        triggers?: { provider: string; event?: string; schedule?: string }[];
      };
      const triggers = doc.triggers ?? [];
      const cron = triggers.find((trigger) => trigger.provider === 'schedule')?.schedule ?? null;
      const webhookEvents = triggers
        .filter((trigger) => trigger.provider !== 'schedule')
        .map((trigger) => trigger.event ?? trigger.provider);
      const schedule = schedules.find((entry) => entry.automation === resource.name) ?? null;
      const relevant = deliveries.filter((entry) => entry.event !== null);
      const accepted = relevant.filter((entry) => entry.status === 'accepted');
      return {
        name: resource.name,
        displayName: doc.displayName ?? resource.name,
        enabled: doc.enabled !== false,
        agent: doc.agent ?? null,
        cron,
        webhookEvents,
        schedule: schedule
          ? {
              status: schedule.status,
              temporalScheduleId: schedule.temporalScheduleId,
              cron: schedule.cron,
              lastFireAt: schedule.lastFireAt,
              lastWorkItemId: schedule.lastWorkItemId,
              fireCount: schedule.fireCount,
              lastError: schedule.lastError,
            }
          : null,
        webhook: {
          deliveries: relevant.length,
          accepted: accepted.length,
          ignored: relevant.filter((entry) => entry.status === 'ignored').length,
          lastDeliveryAt: relevant[0]?.createdAt ?? null,
          lastWorkItemId: accepted[0]?.workItemId ?? null,
        },
      };
    });

  return {
    factory,
    automations,
    webhook: {
      url: `${config.webhookPublicUrl.replace(/\/+$/, '')}/webhooks/github`,
      secretRef: integration?.webhookSecretRef ?? config.webhookSecretRef,
    },
    schedules,
  };
}

export const automationSyncBodySchema = z.object({ factory: z.string().min(1) }).strict();
