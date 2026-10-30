import type { SQL } from 'bun';

/**
 * Merge queue read model (Phase 3b, ADR-022). The queue owns merges: agents enqueue pull
 * requests, a batch merges them, the merged stack is gated, and a red stack is bisected or
 * reverted. Every write is keyed by a natural id so a Temporal retry is idempotent.
 */

export const MERGE_BATCH_STATUSES = [
  'queued',
  'merging',
  'verifying',
  'merged',
  'bisected',
  'reverted',
  'checks_timeout',
  'failed',
] as const;
export type MergeBatchStatus = (typeof MERGE_BATCH_STATUSES)[number];

export const MERGE_ITEM_STATUSES = [
  'queued',
  'batched',
  'merged',
  'reverted',
  'needs_human',
  'failed',
] as const;
export type MergeItemStatus = (typeof MERGE_ITEM_STATUSES)[number];

export const MERGE_EVENT_TYPES = [
  'merge.batch.started',
  'merge.batch.merged',
  'merge.batch.red',
  'merge.bisected',
  'merge.item.merged',
  'merge.item.needs_human',
  'merge.item.failed',
  'merge.checks_timeout',
  'merge.reverted',
] as const;
export type MergeEventType = (typeof MERGE_EVENT_TYPES)[number];

export interface MergeCheckRecord {
  name: string;
  conclusion: string;
  url?: string;
}

export interface MergeBatchRecord {
  id: string;
  factory: string;
  repo: string;
  status: MergeBatchStatus;
  batchSize: number;
  baseSha: string | null;
  mergeSha: string | null;
  checks: MergeCheckRecord[];
  evidence: Record<string, unknown>;
  actor: string | null;
  reason: string | null;
  workflowId: string | null;
  createdAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface MergeBatchItemRecord {
  id: string;
  batchId: string | null;
  factory: string;
  prNumber: number;
  workItemId: string | null;
  head: string;
  status: MergeItemStatus;
  commitSha: string | null;
  evidence: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface MergeEventRecord {
  id: number;
  batchId: string;
  factory: string;
  type: string;
  subject: string;
  payload: Record<string, unknown>;
  createdAt: string | null;
}

interface BatchRow {
  id: string;
  factory: string;
  repo: string;
  status: string;
  batch_size: number | string;
  base_sha: string | null;
  merge_sha: string | null;
  checks: unknown;
  evidence: unknown;
  actor: string | null;
  reason: string | null;
  workflow_id: string | null;
  created_at: unknown;
  started_at: unknown;
  ended_at: unknown;
}

interface ItemRow {
  id: string;
  batch_id: string | null;
  factory: string;
  pr_number: number | string;
  work_item_id: string | null;
  head: string;
  status: string;
  commit_sha: string | null;
  evidence: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface EventRow {
  id: number | string;
  batch_id: string;
  factory: string;
  type: string;
  subject: string;
  payload: unknown;
  created_at: unknown;
}

function parseJsonb<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapBatch(row: BatchRow): MergeBatchRecord {
  return {
    id: row.id,
    factory: row.factory,
    repo: row.repo,
    status: row.status as MergeBatchStatus,
    batchSize: Number(row.batch_size),
    baseSha: row.base_sha,
    mergeSha: row.merge_sha,
    checks: parseJsonb<MergeCheckRecord[]>(row.checks, []),
    evidence: parseJsonb<Record<string, unknown>>(row.evidence, {}),
    actor: row.actor,
    reason: row.reason,
    workflowId: row.workflow_id,
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
  };
}

function mapItem(row: ItemRow): MergeBatchItemRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    factory: row.factory,
    prNumber: Number(row.pr_number),
    workItemId: row.work_item_id,
    head: row.head,
    status: row.status as MergeItemStatus,
    commitSha: row.commit_sha,
    evidence: parseJsonb<Record<string, unknown>>(row.evidence, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapEvent(row: EventRow): MergeEventRecord {
  return {
    id: Number(row.id),
    batchId: row.batch_id,
    factory: row.factory,
    type: row.type,
    subject: row.subject,
    payload: parseJsonb<Record<string, unknown>>(row.payload, {}),
    createdAt: iso(row.created_at),
  };
}

/* ---------------------------------------------------------------- queue */

export interface EnqueueMergeItemArgs {
  id: string;
  factory: string;
  prNumber: number;
  workItemId?: string | null;
  head: string;
}

/** Enqueues a pull request. A duplicate (same factory + PR) returns the existing row. */
export async function enqueueMergeItem(
  sql: SQL,
  args: EnqueueMergeItemArgs,
): Promise<MergeBatchItemRecord> {
  const rows = (await sql`
    insert into merge_batch_items (id, factory, pr_number, work_item_id, head, status)
    values (${args.id}, ${args.factory}, ${args.prNumber}, ${args.workItemId ?? null},
            ${args.head}, 'queued')
    -- The unique index is partial (status <> 'reverted'): inference must name it so a
    -- reverted pull request can be enqueued again.
    on conflict (factory, head) where status <> 'reverted' do nothing
    returning *
  `) as ItemRow[];
  if (rows[0]) return mapItem(rows[0]);
  const existing = (await sql`
    select * from merge_batch_items
    where factory = ${args.factory} and head = ${args.head}
    limit 1
  `) as ItemRow[];
  return mapItem(existing[0] as ItemRow);
}

export async function listQueuedMergeItems(
  sql: SQL,
  factory: string,
  limit: number,
): Promise<MergeBatchItemRecord[]> {
  const rows = (await sql`
    select * from merge_batch_items
    where factory = ${factory} and status = 'queued'
    order by created_at asc
    limit ${Math.min(Math.max(limit, 1), 50)}
  `) as ItemRow[];
  return rows.map(mapItem);
}

export interface CreateMergeBatchArgs {
  id: string;
  factory: string;
  repo: string;
  batchSize: number;
  itemIds: string[];
  workflowId?: string | null;
}

/**
 * Creates the batch and claims its items in one transaction. If a batch is already in
 * flight for the factory the unique partial index rejects the insert, so two batches can
 * never race (spec `merge-queue` › single batch).
 */
export async function createMergeBatch(
  sql: SQL,
  args: CreateMergeBatchArgs,
): Promise<MergeBatchRecord> {
  return await sql.begin(async (tx) => {
    const batches = (await tx`
      insert into merge_batches (id, factory, repo, status, batch_size, workflow_id)
      values (${args.id}, ${args.factory}, ${args.repo}, 'queued', ${args.batchSize},
              ${args.workflowId ?? null})
      returning *
    `) as BatchRow[];

    await tx`
      update merge_batch_items set batch_id = ${args.id}, status = 'batched', updated_at = now()
      where id = any(string_to_array(${args.itemIds.join(',')}, ','))
        and status = 'queued'
    `;

    return mapBatch(batches[0] as BatchRow);
  });
}

export async function getMergeBatch(sql: SQL, id: string): Promise<MergeBatchRecord | null> {
  const rows = (await sql`select * from merge_batches where id = ${id} limit 1`) as BatchRow[];
  return rows[0] ? mapBatch(rows[0]) : null;
}

export async function getInFlightMergeBatch(
  sql: SQL,
  factory: string,
): Promise<MergeBatchRecord | null> {
  const rows = (await sql`
    select * from merge_batches
    where factory = ${factory} and status in ('queued', 'merging', 'verifying')
    order by created_at desc
    limit 1
  `) as BatchRow[];
  return rows[0] ? mapBatch(rows[0]) : null;
}

export async function listMergeBatches(
  sql: SQL,
  factory: string,
  limit = 20,
): Promise<MergeBatchRecord[]> {
  const rows = (await sql`
    select * from merge_batches
    where factory = ${factory}
    order by created_at desc
    limit ${Math.min(Math.max(limit, 1), 100)}
  `) as BatchRow[];
  return rows.map(mapBatch);
}

export interface UpdateMergeBatchArgs {
  id: string;
  status?: MergeBatchStatus;
  baseSha?: string | null;
  mergeSha?: string | null;
  checks?: MergeCheckRecord[];
  evidence?: Record<string, unknown>;
  actor?: string | null;
  reason?: string | null;
  started?: boolean;
  ended?: boolean;
}

export async function updateMergeBatch(
  sql: SQL,
  args: UpdateMergeBatchArgs,
): Promise<MergeBatchRecord | null> {
  const rows = (await sql`
    update merge_batches set
      status = coalesce(${args.status ?? null}, status),
      base_sha = coalesce(${args.baseSha ?? null}, base_sha),
      merge_sha = coalesce(${args.mergeSha ?? null}, merge_sha),
      checks = coalesce(${args.checks ?? null}::jsonb, checks),
      evidence = coalesce(${args.evidence ?? null}::jsonb, evidence),
      actor = coalesce(${args.actor ?? null}, actor),
      reason = coalesce(${args.reason ?? null}, reason),
      started_at = case when ${args.started === true} then coalesce(started_at, now()) else started_at end,
      ended_at = case when ${args.ended === true} then coalesce(ended_at, now()) else ended_at end
    where id = ${args.id}
    returning *
  `) as BatchRow[];
  return rows[0] ? mapBatch(rows[0]) : null;
}

export interface UpdateMergeItemArgs {
  id: string;
  status?: MergeItemStatus;
  commitSha?: string | null;
  evidence?: Record<string, unknown>;
  batchId?: string | null;
}

export async function updateMergeBatchItem(
  sql: SQL,
  args: UpdateMergeItemArgs,
): Promise<MergeBatchItemRecord | null> {
  const rows = (await sql`
    update merge_batch_items set
      status = coalesce(${args.status ?? null}, status),
      commit_sha = coalesce(${args.commitSha ?? null}, commit_sha),
      evidence = coalesce(${args.evidence ?? null}::jsonb, evidence),
      batch_id = coalesce(${args.batchId ?? null}, batch_id),
      updated_at = now()
    where id = ${args.id}
    returning *
  `) as ItemRow[];
  return rows[0] ? mapItem(rows[0]) : null;
}

export async function listMergeBatchItems(
  sql: SQL,
  batchId: string,
): Promise<MergeBatchItemRecord[]> {
  const rows = (await sql`
    select * from merge_batch_items
    where batch_id = ${batchId}
    order by created_at asc
  `) as ItemRow[];
  return rows.map(mapItem);
}

export async function listMergeQueueItems(
  sql: SQL,
  factory: string,
): Promise<MergeBatchItemRecord[]> {
  const rows = (await sql`
    select * from merge_batch_items
    where factory = ${factory} and status in ('queued', 'batched')
    order by created_at asc
  `) as ItemRow[];
  return rows.map(mapItem);
}

/* --------------------------------------------------------------- events */

export async function recordMergeEvent(
  sql: SQL,
  args: {
    batchId: string;
    factory: string;
    type: MergeEventType | string;
    subject?: string;
    payload?: Record<string, unknown>;
  },
): Promise<{ event: MergeEventRecord | null; appended: boolean }> {
  const rows = (await sql`
    insert into merge_events (batch_id, factory, type, subject, payload)
    values (${args.batchId}, ${args.factory}, ${args.type}, ${args.subject ?? ''},
            ${(args.payload ?? {})}::jsonb)
    on conflict (batch_id, type, subject) do nothing
    returning *
  `) as EventRow[];
  if (rows[0]) return { event: mapEvent(rows[0]), appended: true };
  return { event: null, appended: false };
}

export async function listMergeEvents(sql: SQL, batchId: string): Promise<MergeEventRecord[]> {
  const rows = (await sql`
    select * from merge_events where batch_id = ${batchId} order by id asc
  `) as EventRow[];
  return rows.map(mapEvent);
}

export interface MergeQueueView {
  factory: string;
  batches: (MergeBatchRecord & { items: MergeBatchItemRecord[]; events: MergeEventRecord[] })[];
  queued: MergeBatchItemRecord[];
  inFlight: MergeBatchRecord | null;
}

/** The projection the console renders: batches (with items + events) plus the waiting queue. */
export async function getMergeQueueView(
  sql: SQL,
  factory: string,
  limit = 10,
): Promise<MergeQueueView> {
  const [batches, queued, inFlight] = await Promise.all([
    listMergeBatches(sql, factory, limit),
    listMergeQueueItems(sql, factory),
    getInFlightMergeBatch(sql, factory),
  ]);

  const enriched = await Promise.all(
    batches.map(async (batch) => ({
      ...batch,
      items: await listMergeBatchItems(sql, batch.id),
      events: await listMergeEvents(sql, batch.id),
    })),
  );

  return { factory, batches: enriched, queued, inFlight };
}
