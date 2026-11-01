import type { SQL } from 'bun';
import type { AgentVerdict } from '../gates/verdict';
import type { LoopStage } from '../stage-graph/graph';
import {
  isRetryableWorkItemStatus,
  type GateDecisionValue,
  type WorkItem,
  type WorkItemEventType,
  type WorkItemSource,
  type WorkItemStatus,
  type WorkItemType,
  type WorkItemVersion,
} from './types';

/**
 * Work item repository (ADR-010: plain SQL over Bun's `SQL` client, no ORM).
 *
 * Every function takes the `SQL` handle explicitly so the API, the worker and tests share
 * one connection pool and the module stays free of a second singleton.
 *
 * Idempotency: the workflow calls these from activities that Temporal may retry, so
 * transitions are guarded by the expected `from` stage, gate decisions are only written
 * while pending, and PR attachment is a no-op when the URL is unchanged.
 */

/* ------------------------------------------------------------------ rows */

interface WorkItemRow {
  id: string;
  factory: string;
  type: string;
  source: string;
  source_ref: unknown;
  title: string;
  stage: string;
  status: string;
  parent_id: string | null;
  definition_commit: string;
  definition_dirty: boolean;
  canary_rollout_id: string | null;
  definition_version: string;
  pr_url: string | null;
  pr_number: number | null;
  loop_count: number | string;
  workflow_id: string | null;
  cancel_requested_at: unknown;
  cancel_actor: string | null;
  cancel_reason: string | null;
  input?: unknown;
  /** Derived from `work_item.retried` events by `getWorkItem`/`listWorkItems`. */
  retry_count?: number | string;
  retried_at?: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface WorkItemEventRow {
  id: number | string;
  work_item_id: string;
  type: string;
  stage: string | null;
  actor: string | null;
  payload: unknown;
  created_at: unknown;
}

export interface GateDecisionRow {
  work_item_id: string;
  stage: string;
  attempt: number | string;
  gate: string;
  workflow_id: string | null;
  decision: string | null;
  actor: string | null;
  reason: string | null;
  feedback: string | null;
  /** Parsed agent verdict (`{decision, source, summary, findings}`), null for human gates. */
  verdict: unknown;
  automatic: boolean;
  requested_at: unknown;
  sla_at: unknown;
  decided_at: unknown;
}

export interface AutonomyStateRow {
  factory: string;
  enabled: boolean;
  paused: boolean;
  actor: string | null;
  reason: string | null;
  override_actor: string | null;
  override_reason: string | null;
  benchmark_gate_required: boolean;
  updated_at: unknown;
}

export interface WorkItemEvent {
  id: number;
  workItemId: string;
  type: string;
  stage: string | null;
  actor: string | null;
  payload: Record<string, unknown>;
  createdAt: string | null;
}

export interface GateDecisionRecord {
  workItemId: string;
  stage: LoopStage;
  attempt: number;
  gate: string;
  workflowId: string | null;
  decision: GateDecisionValue | null;
  actor: string | null;
  reason: string | null;
  feedback: string | null;
  /** Agent verdict that produced an automatic decision; null when none was parsed. */
  verdict: AgentVerdict | null;
  automatic: boolean;
  requestedAt: string | null;
  slaAt: string | null;
  decidedAt: string | null;
}

export interface AutonomyState {
  factory: string;
  enabled: boolean;
  paused: boolean;
  actor: string | null;
  reason: string | null;
  overrideActor: string | null;
  overrideReason: string | null;
  benchmarkGateRequired: boolean;
  updatedAt: string | null;
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

function mapWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    type: row.type as WorkItemType,
    source: row.source as WorkItemSource,
    sourceRef: parseJsonb<Record<string, unknown>>(row.source_ref, {}),
    title: row.title,
    stage: row.stage as LoopStage,
    status: row.status as WorkItemStatus,
    parentId: row.parent_id,
    factory: row.factory,
    definitionCommit: row.definition_commit,
    canaryRolloutId: row.canary_rollout_id ?? null,
    definitionVersion: (row.definition_version ?? 'stable') as WorkItemVersion,
    definitionDirty: row.definition_dirty === true,
    input: parseJsonb<Record<string, unknown>>(row.input, {}),
    prUrl: row.pr_url,
    prNumber: row.pr_number === null ? null : Number(row.pr_number),
    loopCount: Number(row.loop_count),
    attempt: Number(row.retry_count ?? 0) + 1,
    retriedAt: iso(row.retried_at),
    workflowId: row.workflow_id ?? null,
    cancelRequestedAt: iso(row.cancel_requested_at),
    cancelActor: row.cancel_actor ?? null,
    cancelReason: row.cancel_reason ?? null,
    ...(iso(row.created_at) ? { createdAt: iso(row.created_at) as string } : {}),
    ...(iso(row.updated_at) ? { updatedAt: iso(row.updated_at) as string } : {}),
  };
}

function mapEvent(row: WorkItemEventRow): WorkItemEvent {
  return {
    id: Number(row.id),
    workItemId: row.work_item_id,
    type: row.type,
    stage: row.stage,
    actor: row.actor,
    payload: parseJsonb<Record<string, unknown>>(row.payload, {}),
    createdAt: iso(row.created_at),
  };
}

function mapGate(row: GateDecisionRow): GateDecisionRecord {
  return {
    workItemId: row.work_item_id,
    stage: row.stage as LoopStage,
    attempt: Number(row.attempt),
    gate: row.gate,
    workflowId: row.workflow_id,
    decision: (row.decision as GateDecisionValue | null) ?? null,
    actor: row.actor,
    reason: row.reason,
    feedback: row.feedback,
    verdict: parseJsonb<AgentVerdict | null>(row.verdict, null),
    automatic: row.automatic,
    requestedAt: iso(row.requested_at),
    slaAt: iso(row.sla_at),
    decidedAt: iso(row.decided_at),
  };
}

function mapAutonomy(row: AutonomyStateRow): AutonomyState {
  return {
    factory: row.factory,
    enabled: row.enabled,
    paused: row.paused,
    actor: row.actor,
    reason: row.reason,
    overrideActor: row.override_actor,
    overrideReason: row.override_reason,
    benchmarkGateRequired: row.benchmark_gate_required,
    updatedAt: iso(row.updated_at),
  };
}

/* -------------------------------------------------------------- work items */

export interface CreateWorkItemArgs {
  id: string;
  factory: string;
  type: WorkItemType;
  source: WorkItemSource;
  sourceRef?: Record<string, unknown>;
  title: string;
  stage: LoopStage;
  parentId?: string | null;
  definitionCommit: string;
  definitionDirty?: boolean;
  /** Set when a canary rollout routed this item to the candidate version (ADR-021). */
  canaryRolloutId?: string | null;
  definitionVersion?: WorkItemVersion;
  workflowId?: string | null;
  input?: Record<string, unknown>;
}

export async function createWorkItem(sql: SQL, args: CreateWorkItemArgs): Promise<WorkItem> {
  return await sql.begin(async (tx) => {
    const rows = (await tx`
      insert into work_items (
        id, factory, type, source, source_ref, title, stage, status, parent_id,
        definition_commit, definition_dirty, canary_rollout_id, definition_version,
        workflow_id, input
      ) values (
        ${args.id}, ${args.factory}, ${args.type}, ${args.source},
        ${(args.sourceRef ?? {})}::jsonb, ${args.title}, ${args.stage}, 'active',
        ${args.parentId ?? null}, ${args.definitionCommit}, ${args.definitionDirty ?? false},
        ${args.canaryRolloutId ?? null}, ${args.definitionVersion ?? 'stable'},
        ${args.workflowId ?? null}, ${(args.input ?? {})}::jsonb
      )
      returning *
    `) as WorkItemRow[];

    await tx`
      insert into work_item_events (work_item_id, type, stage, actor, payload)
      values (${args.id}, 'work_item.created', ${args.stage}, ${args.source},
              ${({
                type: args.type,
                source: args.source,
                sourceRef: args.sourceRef ?? {},
                parentId: args.parentId ?? null,
                definitionCommit: args.definitionCommit,
                definitionVersion: args.definitionVersion ?? 'stable',
                canaryRolloutId: args.canaryRolloutId ?? null,
              })}::jsonb)
    `;

    return mapWorkItem(rows[0] as WorkItemRow);
  });
}

/**
 * `attempt`/`retriedAt` are derived from the `work_item.retried` event log (no schema
 * change), so the row plus its audit trail remain the single source of truth.
 */
export async function getWorkItem(sql: SQL, workItemId: string): Promise<WorkItem | null> {
  const rows = (await sql`
    select w.*, r.retry_count, r.retried_at
    from work_items w
    left join lateral (
      select count(*)::int as retry_count, max(e.created_at) as retried_at
      from work_item_events e
      where e.work_item_id = w.id and e.type = 'work_item.retried'
    ) r on true
    where w.id = ${workItemId}
    limit 1
  `) as WorkItemRow[];
  return rows[0] ? mapWorkItem(rows[0]) : null;
}

/**
 * Idempotent creation for a *derived* id (scheduled automation fires, webhook deliveries).
 * The caller derives the id from its idempotency key, so a replayed activity returns the
 * existing row instead of failing on the primary key.
 */
export async function createWorkItemIdempotent(
  sql: SQL,
  args: CreateWorkItemArgs,
): Promise<{ item: WorkItem; created: boolean }> {
  const inserted = await sql.begin(async (tx) => {
    const rows = (await tx`
      insert into work_items (
        id, factory, type, source, source_ref, title, stage, status, parent_id,
        definition_commit, definition_dirty, canary_rollout_id, definition_version,
        workflow_id, input
      ) values (
        ${args.id}, ${args.factory}, ${args.type}, ${args.source},
        ${(args.sourceRef ?? {})}::jsonb, ${args.title}, ${args.stage}, 'active',
        ${args.parentId ?? null}, ${args.definitionCommit}, ${args.definitionDirty ?? false},
        ${args.canaryRolloutId ?? null}, ${args.definitionVersion ?? 'stable'},
        ${args.workflowId ?? null}, ${(args.input ?? {})}::jsonb
      )
      on conflict (id) do nothing
      returning *
    `) as WorkItemRow[];

    if (!rows[0]) return null;

    await tx`
      insert into work_item_events (work_item_id, type, stage, actor, payload)
      values (${args.id}, 'work_item.created', ${args.stage}, ${args.source},
              ${({
                type: args.type,
                source: args.source,
                sourceRef: args.sourceRef ?? {},
                parentId: args.parentId ?? null,
                definitionCommit: args.definitionCommit,
                definitionVersion: args.definitionVersion ?? 'stable',
                canaryRolloutId: args.canaryRolloutId ?? null,
              })}::jsonb)
    `;

    return mapWorkItem(rows[0] as WorkItemRow);
  });

  if (inserted) return { item: inserted, created: true };
  const existing = await getWorkItem(sql, args.id);
  if (!existing) throw new Error(`work item ${args.id} could not be created or read`);
  return { item: existing, created: false };
}

export interface ListWorkItemsFilters {
  factory?: string;
  stage?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function listWorkItems(
  sql: SQL,
  filters: ListWorkItemsFilters = {},
): Promise<WorkItem[]> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const factory = filters.factory ?? null;
  const stage = filters.stage ?? null;
  const status = filters.status ?? null;

  const rows = (await sql`
    select w.*, r.retry_count, r.retried_at
    from work_items w
    left join lateral (
      select count(*)::int as retry_count, max(e.created_at) as retried_at
      from work_item_events e
      where e.work_item_id = w.id and e.type = 'work_item.retried'
    ) r on true
    where (${factory}::text is null or w.factory = ${factory})
      and (${stage}::text is null or w.stage = ${stage})
      and (${status}::text is null or w.status = ${status})
    order by w.created_at desc
    limit ${limit} offset ${offset}
  `) as WorkItemRow[];

  return rows.map(mapWorkItem);
}

export interface TransitionWorkItemArgs {
  workItemId: string;
  from: LoopStage;
  to: LoopStage;
  /** `foreman` (deterministic control flow) or a human/agent actor. */
  by: string;
  actor?: string | null;
  reason?: string | null;
  /** Increments the loop counter (request_changes). */
  loopCountDelta?: number;
}

/**
 * Records a stage transition. Guarded by `from` so a retried activity is a no-op, and the
 * `stage.changed` event carries `from`, `to`, `by` and the reason (spec: stage transition).
 */
export async function transitionWorkItem(
  sql: SQL,
  args: TransitionWorkItemArgs,
): Promise<WorkItem> {
  return await sql.begin(async (tx) => {
    const updated = (await tx`
      update work_items set
        stage = ${args.to},
        loop_count = loop_count + ${args.loopCountDelta ?? 0},
        updated_at = now()
      where id = ${args.workItemId} and stage = ${args.from}
      returning *
    `) as WorkItemRow[];

    if (updated.length === 0) {
      // Already applied (or a stale caller): return the current row unchanged.
      const current = (await tx`
        select * from work_items where id = ${args.workItemId} limit 1
      `) as WorkItemRow[];
      if (!current[0]) throw new Error(`work item ${args.workItemId} does not exist`);
      return mapWorkItem(current[0]);
    }

    await tx`
      insert into work_item_events (work_item_id, type, stage, actor, payload)
      values (${args.workItemId}, 'stage.changed', ${args.to}, ${args.by},
              ${({
                from: args.from,
                to: args.to,
                by: args.by,
                actor: args.actor ?? args.by,
                reason: args.reason ?? null,
                loopCount: Number(updated[0]?.loop_count ?? 0),
              })}::jsonb)
    `;

    return mapWorkItem(updated[0] as WorkItemRow);
  });
}

export async function attachPullRequest(
  sql: SQL,
  args: { workItemId: string; prUrl: string; prNumber?: number | null },
): Promise<WorkItem> {
  return await sql.begin(async (tx) => {
    const current = (await tx`
      select * from work_items where id = ${args.workItemId} limit 1
    `) as WorkItemRow[];
    if (!current[0]) throw new Error(`work item ${args.workItemId} does not exist`);
    if (current[0].pr_url === args.prUrl) return mapWorkItem(current[0]);

    const updated = (await tx`
      update work_items set
        pr_url = ${args.prUrl},
        pr_number = ${args.prNumber ?? null},
        updated_at = now()
      where id = ${args.workItemId}
      returning *
    `) as WorkItemRow[];

    await tx`
      insert into work_item_events (work_item_id, type, stage, actor, payload)
      values (${args.workItemId}, 'pr.opened', ${current[0].stage}, 'forge',
              ${({ prUrl: args.prUrl, prNumber: args.prNumber ?? null })}::jsonb)
    `;

    return mapWorkItem(updated[0] as WorkItemRow);
  });
}

export async function setWorkItemStatus(
  sql: SQL,
  args: { workItemId: string; status: WorkItemStatus; actor?: string; reason?: string | null },
): Promise<WorkItem> {
  return await sql.begin(async (tx) => {
    const updated = (await tx`
      update work_items set status = ${args.status}, updated_at = now()
      where id = ${args.workItemId}
      returning *
    `) as WorkItemRow[];
    if (!updated[0]) throw new Error(`work item ${args.workItemId} does not exist`);

    await tx`
      insert into work_item_events (work_item_id, type, stage, actor, payload)
      values (${args.workItemId}, 'work_item.status', ${updated[0].stage}, ${args.actor ?? 'foreman'},
              ${({ status: args.status, reason: args.reason ?? null })}::jsonb)
    `;

    return mapWorkItem(updated[0] as WorkItemRow);
  });
}

/* ----------------------------------------------------------- event stream */

export async function appendWorkItemEvent(
  sql: SQL,
  args: {
    workItemId: string;
    type: WorkItemEventType | string;
    stage?: string | null;
    actor?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await sql`
    insert into work_item_events (work_item_id, type, stage, actor, payload)
    values (${args.workItemId}, ${args.type}, ${args.stage ?? null}, ${args.actor ?? null},
            ${(args.payload ?? {})}::jsonb)
  `;
}

export async function listWorkItemEvents(
  sql: SQL,
  workItemId: string,
  limit = 200,
): Promise<WorkItemEvent[]> {
  const rows = (await sql`
    select * from work_item_events
    where work_item_id = ${workItemId}
    order by id asc
    limit ${Math.min(Math.max(limit, 1), 1000)}
  `) as WorkItemEventRow[];
  return rows.map(mapEvent);
}

/* ---------------------------------------------------------- gate decisions */

export interface RequestGateArgs {
  workItemId: string;
  stage: LoopStage;
  attempt: number;
  gate: string;
  workflowId: string;
  slaAt?: string | null;
}

/** Creates (or re-opens on retry) the pending gate row for a stage attempt. */
export async function requestGateDecision(
  sql: SQL,
  args: RequestGateArgs,
): Promise<GateDecisionRecord> {
  return await sql.begin(async (tx) => {
    const rows = (await tx`
      with upsert as (
        insert into gate_decisions (
          work_item_id, stage, attempt, gate, workflow_id, requested_at, sla_at
        ) values (
          ${args.workItemId}, ${args.stage}, ${args.attempt}, ${args.gate},
          ${args.workflowId}, now(), ${args.slaAt ?? null}::timestamptz
        )
        on conflict (work_item_id, stage, attempt) do update set
          gate = excluded.gate,
          workflow_id = excluded.workflow_id,
          sla_at = excluded.sla_at
        returning *, (xmax = 0) as inserted
      )
      select * from upsert
    `) as (GateDecisionRow & { inserted: boolean })[];

    const row = rows[0] as GateDecisionRow & { inserted: boolean };
    if (row.inserted) {
      await tx`
        insert into work_item_events (work_item_id, type, stage, actor, payload)
        values (${args.workItemId}, 'gate.requested', ${args.stage}, 'foreman',
                ${({
                  gate: args.gate,
                  attempt: args.attempt,
                  workflowId: args.workflowId,
                  slaAt: args.slaAt ?? null,
                })}::jsonb)
      `;
    }

    return mapGate(row);
  });
}

export interface RecordGateDecisionArgs {
  workItemId: string;
  stage: LoopStage;
  attempt: number;
  decision: GateDecisionValue;
  actor: string;
  reason?: string | null;
  feedback?: string | null;
  /** Parsed agent verdict (change `add-agent-verdicts`); omitted for human decisions. */
  verdict?: AgentVerdict | null;
  automatic?: boolean;
}

/** Writes the decision while the gate is still pending; a retry returns the decided row. */
export async function recordGateDecision(
  sql: SQL,
  args: RecordGateDecisionArgs,
): Promise<GateDecisionRecord> {
  return await sql.begin(async (tx) => {
    const updated = (await tx`
      update gate_decisions set
        decision = ${args.decision},
        actor = ${args.actor},
        reason = ${args.reason ?? null},
        feedback = ${args.feedback ?? null},
        verdict = ${args.verdict ?? null}::jsonb,
        automatic = ${args.automatic ?? false},
        decided_at = now()
      where work_item_id = ${args.workItemId}
        and stage = ${args.stage}
        and attempt = ${args.attempt}
        and decision is null
      returning *
    `) as GateDecisionRow[];

    if (updated.length === 0) {
      const current = (await tx`
        select * from gate_decisions
        where work_item_id = ${args.workItemId} and stage = ${args.stage} and attempt = ${args.attempt}
        limit 1
      `) as GateDecisionRow[];
      if (!current[0]) {
        throw new Error(
          `gate ${args.workItemId}/${args.stage}/${args.attempt} was never requested`,
        );
      }
      return mapGate(current[0]);
    }

    await tx`
      insert into work_item_events (work_item_id, type, stage, actor, payload)
      values (${args.workItemId}, 'gate.decided', ${args.stage}, ${args.actor},
              ${({
                decision: args.decision,
                actor: args.actor,
                reason: args.reason ?? null,
                feedback: args.feedback ?? null,
                verdict: args.verdict ?? null,
                automatic: args.automatic ?? false,
                attempt: args.attempt,
              })}::jsonb)
    `;

    return mapGate(updated[0] as GateDecisionRow);
  });
}

/** Latest undecided gate for a work item (optionally for one stage). */
export async function getPendingGate(
  sql: SQL,
  args: { workItemId: string; stage?: string },
): Promise<GateDecisionRecord | null> {
  const stage = args.stage ?? null;
  const rows = (await sql`
    select * from gate_decisions
    where work_item_id = ${args.workItemId}
      and decision is null
      and (${stage}::text is null or stage = ${stage})
    order by attempt desc
    limit 1
  `) as GateDecisionRow[];
  return rows[0] ? mapGate(rows[0]) : null;
}

export async function listGateDecisions(
  sql: SQL,
  workItemId: string,
): Promise<GateDecisionRecord[]> {
  const rows = (await sql`
    select * from gate_decisions
    where work_item_id = ${workItemId}
    order by requested_at asc, attempt asc
  `) as GateDecisionRow[];
  return rows.map(mapGate);
}

/* ---------------------------------------------------------------- autonomy */

export async function getAutonomyState(sql: SQL, factory: string): Promise<AutonomyState | null> {
  const rows = (await sql`
    select * from autonomy_state where factory = ${factory} limit 1
  `) as AutonomyStateRow[];
  return rows[0] ? mapAutonomy(rows[0]) : null;
}

export interface SetAutonomyStateArgs {
  factory: string;
  enabled: boolean;
  paused: boolean;
  actor: string;
  reason: string;
  overrideActor?: string | null;
  overrideReason?: string | null;
  benchmarkGateRequired?: boolean;
}

/* ------------------------------------------------------ cancellation (1.2) */

export interface WorkItemCancelState {
  requested: boolean;
  requestedAt: string | null;
  actor: string | null;
  reason: string | null;
}

/**
 * Reads the recorded cancellation request. The workflow checks this before every
 * dispatch, so a lost Signal cannot resurrect a cancelled item (ADR-013 pattern).
 */
export async function getWorkItemCancel(
  sql: SQL,
  workItemId: string,
): Promise<WorkItemCancelState> {
  const rows = (await sql`
    select cancel_requested_at, cancel_actor, cancel_reason
    from work_items where id = ${workItemId} limit 1
  `) as Pick<WorkItemRow, 'cancel_requested_at' | 'cancel_actor' | 'cancel_reason'>[];
  const row = rows[0];
  if (!row) throw new Error(`work item ${workItemId} does not exist`);
  return {
    requested: row.cancel_requested_at !== null && row.cancel_requested_at !== undefined,
    requestedAt: iso(row.cancel_requested_at),
    actor: row.cancel_actor ?? null,
    reason: row.cancel_reason ?? null,
  };
}

export interface RequestWorkItemCancelArgs {
  workItemId: string;
  actor: string;
  reason: string;
  stage?: string | null;
}

/**
 * Records the cancellation request once (actor + reason + timestamp) and appends
 * `cancel.requested`. A repeat call is a no-op that returns the current row and
 * `requested: false`, so the audit log never gains a second request.
 */
export async function requestWorkItemCancel(
  sql: SQL,
  args: RequestWorkItemCancelArgs,
): Promise<{ item: WorkItem; requested: boolean; alreadyRequested: boolean }> {
  return await sql.begin(async (tx) => {
    const updated = (await tx`
      update work_items set
        cancel_requested_at = now(),
        cancel_actor = ${args.actor},
        cancel_reason = ${args.reason},
        updated_at = now()
      where id = ${args.workItemId} and cancel_requested_at is null
      returning *
    `) as WorkItemRow[];

    if (!updated[0]) {
      const current = (await tx`
        select * from work_items where id = ${args.workItemId} limit 1
      `) as WorkItemRow[];
      if (!current[0]) throw new Error(`work item ${args.workItemId} does not exist`);
      return { item: mapWorkItem(current[0]), requested: false, alreadyRequested: true };
    }

    await tx`
      insert into work_item_events (work_item_id, type, stage, actor, payload)
      values (${args.workItemId}, 'cancel.requested', ${args.stage ?? updated[0].stage}, ${args.actor},
              ${({
                actor: args.actor,
                reason: args.reason,
                requestedAt: iso(updated[0].cancel_requested_at),
              })}::jsonb)
    `;

    return { item: mapWorkItem(updated[0]), requested: true, alreadyRequested: false };
  });
}

/**
 * Terminal write for a cancellation. Sets the item `cancelled` and appends exactly one
 * `work_item.cancelled` event (a retried activity is a no-op). Called by the workflow
 * when the Signal arrives or when the pre-dispatch read sees a recorded request.
 */
export async function markWorkItemCancelled(
  sql: SQL,
  args: { workItemId: string; stage?: string | null; actor?: string | null; reason?: string | null },
): Promise<WorkItem> {
  return await sql.begin(async (tx) => {
    const updated = (await tx`
      update work_items set status = 'cancelled', updated_at = now()
      where id = ${args.workItemId}
      returning *
    `) as WorkItemRow[];
    if (!updated[0]) throw new Error(`work item ${args.workItemId} does not exist`);

    const inserted = (await tx`
      insert into work_item_events (work_item_id, type, stage, actor, payload)
      select ${args.workItemId}, 'work_item.cancelled', ${args.stage ?? updated[0].stage},
             ${args.actor ?? 'human'},
             ${({
               actor: args.actor ?? null,
               reason: args.reason ?? null,
               cancelledAt: iso(updated[0].updated_at),
             })}::jsonb
      where not exists (
        select 1 from work_item_events
        where work_item_id = ${args.workItemId} and type = 'work_item.cancelled'
      )
      returning id
    `) as { id: number }[];
    void inserted;

    return mapWorkItem(updated[0]);
  });
}

/* -------------------------------------------------------- retry (fix-run-actions) */

export interface WorkItemRetryRecord {
  /** The item attempt this retry produced (1 = first dispatch, so the first retry is 2). */
  attempt: number;
  previousStatus: string | null;
  actor: string | null;
  reason: string | null;
  workflowId: string | null;
  retriedAt: string | null;
}

/** The newest `work_item.retried` event, or null when the item was never retried. */
export async function latestWorkItemRetry(
  sql: SQL,
  workItemId: string,
): Promise<WorkItemRetryRecord | null> {
  const rows = (await sql`
    select * from work_item_events
    where work_item_id = ${workItemId} and type = 'work_item.retried'
    order by id desc
    limit 1
  `) as WorkItemEventRow[];
  const row = rows[0];
  if (!row) return null;
  const payload = parseJsonb<Record<string, unknown>>(row.payload, {});
  const attempt = Number(payload.attempt);
  return {
    attempt: Number.isFinite(attempt) && attempt >= 1 ? attempt : 1,
    previousStatus: typeof payload.previousStatus === 'string' ? payload.previousStatus : null,
    actor: typeof payload.actor === 'string' ? payload.actor : row.actor,
    reason: typeof payload.reason === 'string' ? payload.reason : null,
    workflowId: typeof payload.workflowId === 'string' ? payload.workflowId : null,
    retriedAt: iso(row.created_at),
  };
}

export interface RetryWorkItemArgs {
  workItemId: string;
  stage: LoopStage;
  actor: string;
  reason?: string | null;
  /** Item attempt produced by this retry; the workflow id embeds it. */
  attempt: number;
  workflowId: string;
}

export interface RetryWorkItemResult {
  item: WorkItem;
  /** False when the guard refused (the status was not retryable at write time). */
  applied: boolean;
  previousStatus: string | null;
}

/**
 * Re-opens a terminal item (spec `factory-loop` › Work-item retry): transitions
 * `escalated|failed|blocked|cancelled` → `active` at the current stage, clears the
 * cancellation flags (the prior cancellation stays in the event log as history), points
 * the row at the new attempt workflow and appends exactly one `work_item.retried` event.
 *
 * The row is locked first so two concurrent retries cannot both apply; the loser sees
 * `applied: false` and must not start a second workflow.
 */
export async function retryWorkItem(
  sql: SQL,
  args: RetryWorkItemArgs,
): Promise<RetryWorkItemResult> {
  return await sql.begin(async (tx) => {
    const current = (await tx`
      select * from work_items where id = ${args.workItemId} for update
    `) as WorkItemRow[];
    const row = current[0];
    if (!row) throw new Error(`work item ${args.workItemId} does not exist`);

    if (!isRetryableWorkItemStatus(row.status)) {
      return { item: mapWorkItem(row), applied: false, previousStatus: row.status };
    }

    const updated = (await tx`
      update work_items set
        status = 'active',
        cancel_requested_at = null,
        cancel_actor = null,
        cancel_reason = null,
        workflow_id = ${args.workflowId},
        updated_at = now()
      where id = ${args.workItemId}
      returning *
    `) as WorkItemRow[];

    await tx`
      insert into work_item_events (work_item_id, type, stage, actor, payload)
      values (${args.workItemId}, 'work_item.retried', ${args.stage}, ${args.actor},
              ${({
                previousStatus: row.status,
                actor: args.actor,
                reason: args.reason ?? null,
                attempt: args.attempt,
                workflowId: args.workflowId,
                retriedAt: iso(updated[0]?.updated_at),
              })}::jsonb)
    `;

    return {
      item: mapWorkItem(updated[0] as WorkItemRow),
      applied: true,
      previousStatus: row.status,
    };
  });
}

/** Newest `autonomy.*` event for a factory, across every work item it owns (task 1.1). */
export async function latestAutonomyEvent(
  sql: SQL,
  factory: string,
): Promise<WorkItemEvent | null> {
  const rows = (await sql`
    select e.*
    from work_item_events e
    join work_items w on w.id = e.work_item_id
    where w.factory = ${factory} and e.type like 'autonomy.%'
    order by e.id desc
    limit 1
  `) as WorkItemEventRow[];
  return rows[0] ? mapEvent(rows[0]) : null;
}

export async function setAutonomyState(
  sql: SQL,
  args: SetAutonomyStateArgs,
): Promise<AutonomyState> {
  const rows = (await sql`
    insert into autonomy_state (
      factory, enabled, paused, actor, reason, override_actor, override_reason,
      benchmark_gate_required, updated_at
    ) values (
      ${args.factory}, ${args.enabled}, ${args.paused}, ${args.actor}, ${args.reason},
      ${args.overrideActor ?? null}, ${args.overrideReason ?? null},
      ${args.benchmarkGateRequired ?? false}, now()
    )
    on conflict (factory) do update set
      enabled = excluded.enabled,
      paused = excluded.paused,
      actor = excluded.actor,
      reason = excluded.reason,
      override_actor = coalesce(excluded.override_actor, autonomy_state.override_actor),
      override_reason = coalesce(excluded.override_reason, autonomy_state.override_reason),
      benchmark_gate_required = excluded.benchmark_gate_required,
      updated_at = now()
    returning *
  `) as AutonomyStateRow[];
  return mapAutonomy(rows[0] as AutonomyStateRow);
}
