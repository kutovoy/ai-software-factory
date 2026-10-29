import type { SQL } from 'bun';
import type { LoopStage } from '../stage-graph/graph';
import type {
  GateDecisionValue,
  WorkItem,
  WorkItemEventType,
  WorkItemSource,
  WorkItemStatus,
  WorkItemType,
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
  pr_url: string | null;
  pr_number: number | null;
  loop_count: number | string;
  workflow_id: string | null;
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
    prUrl: row.pr_url,
    prNumber: row.pr_number === null ? null : Number(row.pr_number),
    loopCount: Number(row.loop_count),
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
  workflowId?: string | null;
  input?: Record<string, unknown>;
}

export async function createWorkItem(sql: SQL, args: CreateWorkItemArgs): Promise<WorkItem> {
  return await sql.begin(async (tx) => {
    const rows = (await tx`
      insert into work_items (
        id, factory, type, source, source_ref, title, stage, status, parent_id,
        definition_commit, definition_dirty, workflow_id, input
      ) values (
        ${args.id}, ${args.factory}, ${args.type}, ${args.source},
        ${JSON.stringify(args.sourceRef ?? {})}::jsonb, ${args.title}, ${args.stage}, 'active',
        ${args.parentId ?? null}, ${args.definitionCommit}, ${args.definitionDirty ?? false},
        ${args.workflowId ?? null}, ${JSON.stringify(args.input ?? {})}::jsonb
      )
      returning *
    `) as WorkItemRow[];

    await tx`
      insert into work_item_events (work_item_id, type, stage, actor, payload)
      values (${args.id}, 'work_item.created', ${args.stage}, ${args.source},
              ${JSON.stringify({
                type: args.type,
                source: args.source,
                sourceRef: args.sourceRef ?? {},
                parentId: args.parentId ?? null,
                definitionCommit: args.definitionCommit,
              })}::jsonb)
    `;

    return mapWorkItem(rows[0] as WorkItemRow);
  });
}

export async function getWorkItem(sql: SQL, workItemId: string): Promise<WorkItem | null> {
  const rows = (await sql`
    select * from work_items where id = ${workItemId} limit 1
  `) as WorkItemRow[];
  return rows[0] ? mapWorkItem(rows[0]) : null;
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
    select * from work_items
    where (${factory}::text is null or factory = ${factory})
      and (${stage}::text is null or stage = ${stage})
      and (${status}::text is null or status = ${status})
    order by created_at desc
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
              ${JSON.stringify({
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
              ${JSON.stringify({ prUrl: args.prUrl, prNumber: args.prNumber ?? null })}::jsonb)
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
              ${JSON.stringify({ status: args.status, reason: args.reason ?? null })}::jsonb)
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
            ${JSON.stringify(args.payload ?? {})}::jsonb)
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
                ${JSON.stringify({
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
              ${JSON.stringify({
                decision: args.decision,
                actor: args.actor,
                reason: args.reason ?? null,
                feedback: args.feedback ?? null,
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
