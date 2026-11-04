import {
  mapGate,
  mapWorkItem,
  type GateDecisionRecord,
  type GateDecisionRow,
  type WorkItemRow,
} from '@factory/core';
import { getSql, type RunRow } from '@factory/orchestration';
import { ownerFilter, type Viewer } from './auth';
import { summarize as summarizeWorkItem, type WorkItemSummary } from './work-items';

/**
 * Batch inbox projection (performance plan, `docs/PERFORMANCE.md`).
 *
 * The console used to build the inbox from one list call per factory plus a detail call per
 * open run and per non-terminal work item (~112 API calls, each re-syncing the registry).
 * This endpoint answers the same question with three indexed queries: pending gates,
 * pending permissions and failed runs. Ownership is applied in SQL, so a member never sees
 * another member's rows.
 */

export interface InboxGate {
  workItem: WorkItemSummary;
  /** Stable factory id for links; falls back to the internal key for pre-identity rows. */
  factoryId: string;
  factoryName: string;
  gate: GateDecisionRecord;
}

export interface InboxPermission {
  runId: string;
  factoryId: string;
  factoryName: string;
  title: string;
  action: string;
  requestId: string;
  requestedAt: string;
  commit: string;
}

export interface InboxFailure {
  runId: string;
  factoryId: string;
  factoryName: string;
  title: string;
  at: string;
  commit: string;
  errorCode: string;
  error: string;
}

export interface InboxProjection {
  gates: InboxGate[];
  permissions: InboxPermission[];
  failures: InboxFailure[];
  counts: {
    gates: number;
    permissions: number;
    failures: number;
  };
}

interface GateInboxRow extends WorkItemRow {
  g_stage: string;
  g_attempt: number | string;
  g_gate: string;
  g_workflow_id: string | null;
  g_decision: string | null;
  g_actor: string | null;
  g_reason: string | null;
  g_feedback: string | null;
  g_verdict: unknown;
  g_automatic: boolean;
  g_requested_at: unknown;
  g_sla_at: unknown;
  g_decided_at: unknown;
  factory_identity: string | null;
  factory_name: string | null;
  factory_alias: string | null;
  total_count: number | string;
}

interface PermissionInboxRow extends RunRow {
  request_id: string;
  action: string;
  detail: unknown;
  decision: string | null;
  requested_at: unknown;
  decided_at: unknown;
  factory_identity: string | null;
  factory_name: string | null;
  factory_alias: string | null;
  total_count: number | string;
}

interface FailureInboxRow extends RunRow {
  factory_identity: string | null;
  factory_name: string | null;
  factory_alias: string | null;
  total_count: number | string;
}

function factoryIdOf(row: {
  factory_id?: string | null;
  factory_identity: string | null;
  factory?: string | null;
}): string {
  return row.factory_id ?? row.factory_identity ?? row.factory ?? '';
}

function factoryLabel(row: {
  factory_alias: string | null;
  factory_name: string | null;
  factory?: string | null;
}): string {
  return row.factory_alias?.trim() || row.factory_name || row.factory || '';
}

function iso(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function errorCodeOf(error: string | null): string {
  return error ? (error.split(':')[0]?.trim() || 'run_failed') : 'run_failed';
}

export async function getInboxForApi(
  viewer: Viewer | null,
  options: { limit?: number } = {},
): Promise<InboxProjection> {
  const sql = getSql();
  const owner = ownerFilter(viewer);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

  const [gateRows, permissionRows, failureRows] = await Promise.all([
    sql`
      select
        w.*,
        r.retry_count,
        r.retried_at,
        g.stage as g_stage,
        g.attempt as g_attempt,
        g.gate as g_gate,
        g.workflow_id as g_workflow_id,
        g.decision as g_decision,
        g.actor as g_actor,
        g.reason as g_reason,
        g.feedback as g_feedback,
        g.verdict as g_verdict,
        g.automatic as g_automatic,
        g.requested_at as g_requested_at,
        g.sla_at as g_sla_at,
        g.decided_at as g_decided_at,
        f.id as factory_identity,
        f.name as factory_name,
        f.alias as factory_alias,
        count(*) over() as total_count
      from gate_decisions g
      join work_items w on w.id = g.work_item_id
      left join lateral (
        select count(*)::int as retry_count, max(e.created_at) as retried_at
        from work_item_events e
        where e.work_item_id = w.id and e.type = 'work_item.retried'
      ) r on true
      left join factories f on f.key = w.factory
      where g.decision is null
        and (${owner}::uuid is null or w.created_by = ${owner}::uuid)
      order by g.requested_at desc
      limit ${limit}
    `,
    sql`
      select
        r.*,
        rp.request_id,
        rp.action,
        rp.detail,
        rp.decision,
        rp.requested_at,
        rp.decided_at,
        f.id as factory_identity,
        f.name as factory_name,
        f.alias as factory_alias,
        count(*) over() as total_count
      from run_permissions rp
      join runs r on r.id = rp.run_id
      left join work_items w on w.id = 'wi_' || substr(r.id, 5, 26)
      left join factories f on f.key = r.factory
      where rp.decision is null
        and (
          ${owner}::uuid is null
          or r.created_by = ${owner}::uuid
          or w.created_by = ${owner}::uuid
        )
      order by rp.requested_at desc
      limit ${limit}
    `,
    sql`
      select
        r.*,
        f.id as factory_identity,
        f.name as factory_name,
        f.alias as factory_alias,
        count(*) over() as total_count
      from runs r
      left join work_items w on w.id = 'wi_' || substr(r.id, 5, 26)
      left join factories f on f.key = r.factory
      where r.status = 'error'
        and (
          ${owner}::uuid is null
          or r.created_by = ${owner}::uuid
          or w.created_by = ${owner}::uuid
        )
      order by coalesce(r.ended_at, r.started_at) desc
      limit ${limit}
    `,
  ]) as [GateInboxRow[], PermissionInboxRow[], FailureInboxRow[]];

  const gates: InboxGate[] = gateRows.map((row) => ({
    workItem: summarizeWorkItem(mapWorkItem(row)),
    factoryId: factoryIdOf(row),
    factoryName: factoryLabel(row),
    gate: mapGate({
      work_item_id: row.id,
      stage: row.g_stage,
      attempt: row.g_attempt,
      gate: row.g_gate,
      workflow_id: row.g_workflow_id,
      decision: row.g_decision,
      actor: row.g_actor,
      reason: row.g_reason,
      feedback: row.g_feedback,
      verdict: row.g_verdict,
      automatic: row.g_automatic === true,
      requested_at: row.g_requested_at,
      sla_at: row.g_sla_at,
      decided_at: row.g_decided_at,
    } satisfies GateDecisionRow),
  }));

  const permissions: InboxPermission[] = permissionRows.map((row) => ({
    runId: row.id,
    factoryId: factoryIdOf(row),
    factoryName: factoryLabel(row),
    title: row.title ?? row.id,
    action: row.action,
    requestId: row.request_id,
    requestedAt: iso(row.requested_at),
    commit: row.definition_commit,
  }));

  const failures: InboxFailure[] = failureRows.map((row) => ({
    runId: row.id,
    factoryId: factoryIdOf(row),
    factoryName: factoryLabel(row),
    title: row.title ?? row.id,
    at: iso(row.ended_at ?? row.started_at),
    commit: row.definition_commit,
    errorCode: errorCodeOf(row.error),
    error: row.error ?? 'the run ended with status error',
  }));

  return {
    gates,
    permissions,
    failures,
    counts: {
      gates: Number(gateRows[0]?.total_count ?? gates.length),
      permissions: Number(permissionRows[0]?.total_count ?? permissions.length),
      failures: Number(failureRows[0]?.total_count ?? failures.length),
    },
  };
}
