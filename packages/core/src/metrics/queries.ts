import type { SQL } from 'bun';
import {
  buildFactoryMetrics,
  type CheckMetricRow,
  type FactoryMetricsResult,
  type GateMetricRow,
  type PermissionMetricRow,
  type RunMetricRow,
  type WorkItemMetricRow,
} from './compute';
import { parseMetricsWindow, type MetricsWindow } from './window';

/**
 * Derived metric queries (ADR-017): computed at read time from the existing read model —
 * `runs`, `work_items`, `gate_decisions`, `work_item_events`, `run_permissions`. There are
 * no counters to drift, and the window is explicit in every response.
 */

const STAGE_RUN_RE =
  /^run_([0-9A-HJKMNP-TV-Z]{26})_(triage|spec|plan|implement|review|verify|ship)_(\d+)(?:_r\d+)?$/;

/** `run_<workItemUlid>_<stage>_<attempt>[_rN]` → stage attribution. */
export function parseStageRunId(
  runId: string,
): { workItemId: string; stage: string } | null {
  const match = STAGE_RUN_RE.exec(runId);
  if (!match) return null;
  return { workItemId: `wi_${match[1]}`, stage: match[2] as string };
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface FactoryMetricsResponse extends FactoryMetricsResult {
  factory: string;
  window: MetricsWindow;
}

export async function computeFactoryMetrics(
  sql: SQL,
  factory: string,
  windowInput?: string | null,
): Promise<FactoryMetricsResponse> {
  const window = parseMetricsWindow(windowInput);

  const [workItemRows, gateRows, permissionRows, runRows, checkRows] = await Promise.all([
    sql`
      select
        w.id, w.type, w.status, w.created_at, w.pr_url, w.pr_number, w.source,
        (
          select max(e.created_at)
          from work_item_events e
          where e.work_item_id = w.id
            and e.type = 'work_item.status'
            and e.payload->>'status' = 'done'
        ) as done_at
      from work_items w
      where w.factory = ${factory} and w.created_at >= ${window.from}::timestamptz
    ` as Promise<{
      id: string;
      type: string;
      status: string;
      created_at: unknown;
      pr_url: string | null;
      pr_number: number | null;
      source: string | null;
      done_at: unknown;
    }[]>,
    sql`
      select g.work_item_id, g.gate, g.automatic, g.requested_at, g.decided_at
      from gate_decisions g
      join work_items w on w.id = g.work_item_id
      where w.factory = ${factory}
        and w.created_at >= ${window.from}::timestamptz
        and g.decision is not null
    ` as Promise<{
      work_item_id: string;
      gate: string;
      automatic: boolean;
      requested_at: unknown;
      decided_at: unknown;
    }[]>,
    sql`
      select rp.run_id, rp.decided_at
      from run_permissions rp
      join runs r on r.id = rp.run_id
      where r.factory = ${factory}
        and rp.decided_at is not null
        and rp.decided_at >= ${window.from}::timestamptz
    ` as Promise<{ run_id: string; decided_at: unknown }[]>,
    sql`
      select id, started_at, cost_usd
      from runs
      where factory = ${factory} and started_at >= ${window.from}::timestamptz
    ` as Promise<{ id: string; started_at: unknown; cost_usd: unknown }[]>,
    sql`
      select e.work_item_id, e.payload->>'green' as green, e.created_at
      from work_item_events e
      join work_items w on w.id = e.work_item_id
      where w.factory = ${factory}
        and e.type = 'checks.recorded'
        and w.created_at >= ${window.from}::timestamptz
    ` as Promise<{ work_item_id: string; green: string | null; created_at: unknown }[]>,
  ]);

  const workItems: WorkItemMetricRow[] = workItemRows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    createdAt: iso(row.created_at),
    doneAt: iso(row.done_at),
    prUrl: row.pr_url,
    prNumber: row.pr_number === null ? null : Number(row.pr_number),
    source: row.source ?? undefined,
  }));

  const gates: GateMetricRow[] = gateRows.map((row) => ({
    workItemId: row.work_item_id,
    gate: row.gate,
    automatic: row.automatic,
    requestedAt: iso(row.requested_at),
    decidedAt: iso(row.decided_at),
  }));

  const permissions: PermissionMetricRow[] = permissionRows.map((row) => ({
    runId: row.run_id,
    workItemId: parseStageRunId(row.run_id)?.workItemId ?? null,
    decidedAt: iso(row.decided_at),
  }));

  const runs: RunMetricRow[] = runRows.map((row) => {
    const parsed = parseStageRunId(row.id);
    return {
      id: row.id,
      startedAt: iso(row.started_at),
      costUsd: numberOrNull(row.cost_usd),
      stage: parsed?.stage ?? null,
      workItemId: parsed?.workItemId ?? null,
    };
  });

  const checks: CheckMetricRow[] = checkRows.map((row) => ({
    workItemId: row.work_item_id,
    green: row.green === 'true',
    createdAt: iso(row.created_at),
  }));

  const computed = buildFactoryMetrics({ window, workItems, gates, permissions, runs, checks });
  return { factory, window, ...computed };
}
