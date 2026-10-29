import { ApplicationFailure } from '@temporalio/activity';
import {
  appendWorkItemEvent,
  getMergeBatch,
  getMergeQueueView,
  listMergeBatchItems,
  recordMergeEvent,
  setWorkItemStatus,
  updateMergeBatch,
  updateMergeBatchItem,
  createMergeBatch,
  enqueueMergeItem,
  getInFlightMergeBatch,
  listQueuedMergeItems,
  type MergeBatchItemRecord,
  type MergeBatchRecord,
  type MergeCheckRecord,
  type MergeItemStatus,
} from '@factory/core';
import {
  revertMergeBatch,
  runMergeBatch,
  selectBatch,
  type MergeQueueBatch,
  type MergeQueueEvent,
  type MergeQueueItem,
} from '@factory/merge';
import { repoKey, type CheckRun, type RepoRef } from '@factory/forge';
import { getSql } from '../db';
import { loadConfig } from '../config';
import { ensureMergeQueueWorkflow } from '../merge-client';
import type { MergeQueueBatchOutcome } from '../types';
import { factoryRepo, getForge } from './forge';

/**
 * Merge queue activities (spec `merge-queue`, ADR-022).
 *
 * The queue owns merges: the loop enqueues a PR instead of merging it, the queue workflow
 * picks batches, and every write goes through the `@factory/merge` engine with the injected
 * forge. All persistence is idempotent (`(factory, pr)` for items, `(batch, type, subject)`
 * for events), so a Temporal retry re-runs a batch without merging a PR twice.
 */

const TERMINAL_BATCH = new Set(['merged', 'bisected', 'reverted', 'checks_timeout', 'failed']);

function newId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 26)}`;
}

function asFailure(error: unknown, type: string): never {
  throw ApplicationFailure.create({
    type,
    nonRetryable: true,
    message: error instanceof Error ? error.message : String(error),
  });
}

function parseRepo(value: string): RepoRef {
  const [owner, name] = value.split('/');
  if (!owner || !name) {
    throw ApplicationFailure.create({
      type: 'invalid_repository',
      nonRetryable: true,
      message: `"${value}" is not an owner/name repository reference`,
    });
  }
  return { owner, name };
}

function itemStatus(status: MergeQueueItem['status']): MergeItemStatus {
  return status;
}

function checksToRecord(checks: { name: string; conclusion: string; url?: string }[]): MergeCheckRecord[] {
  return checks.map((check) => ({
    name: check.name,
    conclusion: check.conclusion,
    ...(check.url ? { url: check.url } : {}),
  }));
}

export interface EnqueueMergeRequestArgs {
  factory: string;
  factoryRoot: string;
  pullRequestNumber: number;
  workItemId: string;
  head: string;
}

/**
 * Called by the loop's `ship` stage when the queue owns merges: it records the pull
 * request in the queue and makes sure a queue workflow is running for the factory.
 */
export async function enqueueMergeRequestActivity(
  args: EnqueueMergeRequestArgs,
): Promise<{ itemId: string; workflowId: string; queued: boolean }> {
  const repo = factoryRepo(args.factoryRoot, args.factory);
  const sql = getSql();
  const item = await enqueueMergeItem(sql, {
    id: newId('mb'),
    factory: args.factory,
    prNumber: args.pullRequestNumber,
    workItemId: args.workItemId,
    head: args.head,
  });

  await appendWorkItemEvent(sql, {
    workItemId: args.workItemId,
    type: 'merge.queued',
    stage: 'ship',
    actor: 'foreman',
    payload: { prNumber: args.pullRequestNumber, queueItemId: item.id, repo: repoKey(repo) },
  });

  const config = loadConfig();
  const started = await ensureMergeQueueWorkflow(
    {
      factory: args.factory,
      repo: repoKey(repo),
      batchSize: config.mergeBatchSize,
      checksTimeoutMs: config.mergeChecksTimeoutMs,
      pollIntervalMs: config.mergeChecksPollMs,
      maxBatches: config.mergeMaxBatches,
      idleIntervalMs: config.mergeIdleIntervalMs,
      maxIdleCycles: config.mergeIdleCycles,
      actor: 'foreman',
    },
    config,
  );

  return { itemId: item.id, workflowId: started.workflowId, queued: true };
}

export interface PlanMergeBatchArgs {
  factory: string;
  repo: string;
  batchSize: number;
  workflowId?: string | null;
}

/**
 * Claims the next batch: at most one batch is in flight per factory (unique partial index),
 * so a second caller simply resumes the existing batch.
 */
export async function planMergeBatchActivity(
  args: PlanMergeBatchArgs,
): Promise<{ batchId: string | null; resumed: boolean; queued: number }> {
  const sql = getSql();
  const inFlight = await getInFlightMergeBatch(sql, args.factory);
  if (inFlight) return { batchId: inFlight.id, resumed: true, queued: 0 };

  const queued = await listQueuedMergeItems(sql, args.factory, args.batchSize);
  if (queued.length === 0) return { batchId: null, resumed: false, queued: 0 };

  const batch = await createMergeBatch(sql, {
    id: newId('mb_batch'),
    factory: args.factory,
    repo: args.repo,
    batchSize: args.batchSize,
    itemIds: queued.map((item) => item.id),
    workflowId: args.workflowId ?? null,
  });

  return { batchId: batch.id, resumed: false, queued: queued.length };
}

export interface ExecuteMergeBatchArgs {
  factory: string;
  batchId: string;
  batchSize?: number;
  checksTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** Merges the batch, gates the merged stack, bisects/reverts on red, and persists it all. */
export async function executeMergeBatchActivity(
  args: ExecuteMergeBatchArgs,
): Promise<MergeQueueBatchOutcome> {
  const sql = getSql();
  const batch = await getMergeBatch(sql, args.batchId);
  if (!batch) {
    throw ApplicationFailure.create({
      type: 'merge_batch_not_found',
      nonRetryable: true,
      message: `merge batch "${args.batchId}" does not exist`,
    });
  }

  const items = await listMergeBatchItems(sql, batch.id);
  if (TERMINAL_BATCH.has(batch.status)) {
    return {
      batchId: batch.id,
      status: batch.status,
      merged: items.filter((item) => item.status === 'merged').map((item) => item.prNumber),
      needsHuman: items.filter((item) => item.status === 'needs_human').map((item) => item.prNumber),
      reverted: batch.status === 'reverted' || batch.status === 'bisected' || batch.status === 'checks_timeout',
      ...(batch.reason ? { reason: batch.reason } : {}),
    };
  }

  const repo = parseRepo(batch.repo);
  const engineBatch: MergeQueueBatch = {
    id: batch.id,
    factory: batch.factory,
    repo,
    items: items.map(toEngineItem),
    baseSha: batch.baseSha ?? '',
    mergeSha: batch.mergeSha,
    status: batch.status === 'queued' ? 'queued' : (batch.status as MergeQueueBatch['status']),
    checks: batch.checks.map((check) => ({
      name: check.name,
      conclusion: check.conclusion as CheckRun['conclusion'],
      ...(check.url ? { url: check.url } : {}),
    })),
    evidence: batch.evidence,
  };

  const config = loadConfig();
  let result;
  try {
    result = await runMergeBatch(engineBatch, {
      forge: getForge(),
      repo,
      batchSize: args.batchSize ?? config.mergeBatchSize,
      checksTimeoutMs: args.checksTimeoutMs ?? config.mergeChecksTimeoutMs,
      pollIntervalMs: args.pollIntervalMs ?? config.mergeChecksPollMs,
      hooks: {
        onItem: async (item) => {
          await updateMergeBatchItem(sql, {
            id: item.id,
            status: itemStatus(item.status),
            commitSha: item.commitSha ?? null,
            evidence: item.evidence ?? {},
          });
        },
        onBatch: async (next) => {
          await updateMergeBatch(sql, {
            id: next.id,
            status: next.status,
            baseSha: next.baseSha || null,
            mergeSha: next.mergeSha ?? null,
            checks: checksToRecord(next.checks),
            evidence: next.evidence,
            started: true,
            ended: TERMINAL_BATCH.has(next.status),
            actor: next.actor ?? null,
            reason: next.reason ?? null,
          });
        },
        onEvent: async (event: MergeQueueEvent) => {
          await recordMergeEvent(sql, {
            batchId: event.batchId,
            factory: event.factory,
            type: event.type,
            subject: event.subject ?? '',
            payload: event.payload ?? {},
          });
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateMergeBatch(sql, {
      id: batch.id,
      status: 'failed',
      reason: `merge_batch_failed: ${message}`,
      ended: true,
    });
    await recordMergeEvent(sql, {
      batchId: batch.id,
      factory: batch.factory,
      type: 'merge.item.failed',
      subject: 'batch',
      payload: { message },
    });
    return asFailure(error, 'merge_batch_failed');
  }

  // An offender is handed to a human with its evidence, and the work item follows.
  for (const item of result.needsHuman) {
    if (!item.workItemId) continue;
    await setWorkItemStatus(sql, {
      workItemId: item.workItemId,
      status: 'escalated',
      actor: 'merge-queue',
      reason: `pull request #${item.pullRequestNumber} is red on the merged stack`,
    });
    await appendWorkItemEvent(sql, {
      workItemId: item.workItemId,
      type: 'merge.needs_human',
      stage: 'ship',
      actor: 'merge-queue',
      payload: { prNumber: item.pullRequestNumber, batchId: batch.id, evidence: item.evidence ?? {} },
    });
  }

  for (const item of result.merged) {
    if (!item.workItemId) continue;
    await appendWorkItemEvent(sql, {
      workItemId: item.workItemId,
      type: 'merge.merged',
      stage: 'ship',
      actor: 'merge-queue',
      payload: { prNumber: item.pullRequestNumber, batchId: batch.id, sha: item.commitSha ?? null },
    });
  }

  return {
    batchId: batch.id,
    status: result.batch.status,
    merged: result.merged.map((item) => item.pullRequestNumber),
    needsHuman: result.needsHuman.map((item) => item.pullRequestNumber),
    reverted: result.reverted,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

export interface RevertMergeBatchArgs {
  factory: string;
  batchId: string;
  actor: string;
  reason: string;
}

/**
 * Reverts a batch as one commit regardless of checks (spec: manual revert). Called by the
 * API (operator action) and available to the workflow for post-merge red handling.
 */
export async function revertMergeBatchActivity(
  args: RevertMergeBatchArgs,
): Promise<{ batchId: string; status: string; sha: string; prs: number[] }> {
  const sql = getSql();
  const batch = await getMergeBatch(sql, args.batchId);
  if (!batch) {
    throw ApplicationFailure.create({
      type: 'merge_batch_not_found',
      nonRetryable: true,
      message: `merge batch "${args.batchId}" does not exist`,
    });
  }

  const items = await listMergeBatchItems(sql, batch.id);
  const repo = parseRepo(batch.repo);
  const engineBatch: MergeQueueBatch = {
    id: batch.id,
    factory: batch.factory,
    repo,
    items: items.map(toEngineItem),
    baseSha: batch.baseSha ?? '',
    mergeSha: batch.mergeSha,
    status: batch.status as MergeQueueBatch['status'],
    checks: batch.checks.map((check) => ({
      name: check.name,
      conclusion: check.conclusion as CheckRun['conclusion'],
      ...(check.url ? { url: check.url } : {}),
    })),
    evidence: batch.evidence,
  };

  try {
    const result = await revertMergeBatch(engineBatch, {
      forge: getForge(),
      repo,
      hooks: {
        onItem: async (item: MergeQueueItem) => {
          await updateMergeBatchItem(sql, { id: item.id, status: itemStatus(item.status) });
        },
        onBatch: async (next: MergeQueueBatch) => {
          await updateMergeBatch(sql, {
            id: next.id,
            status: 'reverted',
            mergeSha: next.mergeSha ?? null,
            evidence: next.evidence,
            actor: args.actor,
            reason: args.reason,
            ended: true,
          });
        },
        onEvent: async (event: MergeQueueEvent) => {
          await recordMergeEvent(sql, {
            batchId: event.batchId,
            factory: event.factory,
            type: event.type,
            subject: event.subject ?? '',
            payload: event.payload ?? {},
          });
        },
      },
    }, { actor: args.actor, reason: args.reason });

    for (const item of items) {
      if (!item.workItemId) continue;
      await appendWorkItemEvent(sql, {
        workItemId: item.workItemId,
        type: 'merge.reverted',
        stage: 'ship',
        actor: args.actor,
        payload: { prNumber: item.prNumber, batchId: batch.id, reason: args.reason },
      });
    }

    return {
      batchId: batch.id,
      status: result.batch.status,
      sha: result.sha,
      prs: items.filter((item) => item.status !== 'queued').map((item) => item.prNumber),
    };
  } catch (error) {
    return asFailure(error, 'merge_revert_failed');
  }
}

function toEngineItem(item: MergeBatchItemRecord): MergeQueueItem {
  return {
    id: item.id,
    pullRequestNumber: item.prNumber,
    workItemId: item.workItemId,
    head: item.head,
    status: item.status === 'batched' ? 'batched' : item.status,
    commitSha: item.commitSha,
    evidence: item.evidence,
  };
}

/** Projection used by the API: batches, items and events for one factory. */
export async function getMergeQueueForApi(
  factory: string,
  limit = 10,
): Promise<{
  factory: string;
  inFlight: MergeBatchRecord | null;
  batches: { batch: MergeBatchRecord; items: MergeBatchItemRecord[] }[];
}> {
  const sql = getSql();
  const view = await getMergeQueueView(sql, factory, limit);
  return {
    factory: view.factory,
    inFlight: view.inFlight,
    batches: view.batches.map((batch) => ({
      batch: {
        id: batch.id,
        factory: batch.factory,
        repo: batch.repo,
        status: batch.status,
        batchSize: batch.batchSize,
        baseSha: batch.baseSha,
        mergeSha: batch.mergeSha,
        checks: batch.checks,
        evidence: batch.evidence,
        actor: batch.actor,
        reason: batch.reason,
        workflowId: batch.workflowId,
        createdAt: batch.createdAt,
        startedAt: batch.startedAt,
        endedAt: batch.endedAt,
      },
      items: batch.items,
    })),
  };
}

export { selectBatch };
