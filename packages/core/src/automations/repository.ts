import type { SQL } from 'bun';

/**
 * Automation schedule read model (Phase 3b). A definition automation with a `schedule`
 * becomes a Temporal schedule; this table is the projection the console reads (status,
 * last fire, last work item). Fires are idempotent by `(schedule_id, fire_at)` — the
 * spec's "schedule id + timestamp" key.
 */

export const AUTOMATION_SCHEDULE_STATUSES = ['pending', 'active', 'paused', 'error'] as const;
export type AutomationScheduleStatus = (typeof AUTOMATION_SCHEDULE_STATUSES)[number];

export interface AutomationScheduleRecord {
  id: string;
  factory: string;
  automation: string;
  kind: 'cron' | 'webhook';
  cron: string | null;
  status: AutomationScheduleStatus;
  temporalScheduleId: string | null;
  lastFireAt: string | null;
  lastWorkItemId: string | null;
  fireCount: number;
  lastError: string | null;
  updatedAt: string | null;
}

export interface AutomationFireRecord {
  id: number;
  scheduleId: string;
  fireAt: string | null;
  factory: string;
  automation: string;
  workItemId: string | null;
  skipped: boolean;
  reason: string | null;
  createdAt: string | null;
}

interface ScheduleRow {
  id: string;
  factory: string;
  automation: string;
  kind: string;
  cron: string | null;
  status: string;
  temporal_schedule_id: string | null;
  last_fire_at: unknown;
  last_work_item_id: string | null;
  fire_count: number | string;
  last_error: string | null;
  updated_at: unknown;
}

interface FireRow {
  id: number | string;
  schedule_id: string;
  fire_at: unknown;
  factory: string;
  automation: string;
  work_item_id: string | null;
  skipped: boolean;
  reason: string | null;
  created_at: unknown;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapSchedule(row: ScheduleRow): AutomationScheduleRecord {
  return {
    id: row.id,
    factory: row.factory,
    automation: row.automation,
    kind: row.kind as 'cron' | 'webhook',
    cron: row.cron,
    status: row.status as AutomationScheduleStatus,
    temporalScheduleId: row.temporal_schedule_id,
    lastFireAt: iso(row.last_fire_at),
    lastWorkItemId: row.last_work_item_id,
    fireCount: Number(row.fire_count),
    lastError: row.last_error,
    updatedAt: iso(row.updated_at),
  };
}

function mapFire(row: FireRow): AutomationFireRecord {
  return {
    id: Number(row.id),
    scheduleId: row.schedule_id,
    fireAt: iso(row.fire_at),
    factory: row.factory,
    automation: row.automation,
    workItemId: row.work_item_id,
    skipped: row.skipped,
    reason: row.reason,
    createdAt: iso(row.created_at),
  };
}

export function automationScheduleId(factory: string, automation: string): string {
  return `${factory}:${automation}`;
}

export interface UpsertAutomationScheduleArgs {
  factory: string;
  automation: string;
  kind?: 'cron' | 'webhook';
  cron?: string | null;
  status: AutomationScheduleStatus;
  temporalScheduleId?: string | null;
  lastError?: string | null;
}

export async function upsertAutomationSchedule(
  sql: SQL,
  args: UpsertAutomationScheduleArgs,
): Promise<AutomationScheduleRecord> {
  const rows = (await sql`
    insert into automation_schedules (
      id, factory, automation, kind, cron, status, temporal_schedule_id, last_error, updated_at
    ) values (
      ${automationScheduleId(args.factory, args.automation)}, ${args.factory}, ${args.automation},
      ${args.kind ?? 'cron'}, ${args.cron ?? null}, ${args.status},
      ${args.temporalScheduleId ?? null}, ${args.lastError ?? null}, now()
    )
    on conflict (factory, automation) do update set
      kind = excluded.kind,
      cron = excluded.cron,
      status = excluded.status,
      temporal_schedule_id = coalesce(excluded.temporal_schedule_id, automation_schedules.temporal_schedule_id),
      last_error = excluded.last_error,
      updated_at = now()
    returning *
  `) as ScheduleRow[];
  return mapSchedule(rows[0] as ScheduleRow);
}

export async function listAutomationSchedules(
  sql: SQL,
  factory: string,
): Promise<AutomationScheduleRecord[]> {
  const rows = (await sql`
    select * from automation_schedules where factory = ${factory} order by automation asc
  `) as ScheduleRow[];
  return rows.map(mapSchedule);
}

export async function getAutomationSchedule(
  sql: SQL,
  factory: string,
  automation: string,
): Promise<AutomationScheduleRecord | null> {
  const rows = (await sql`
    select * from automation_schedules
    where factory = ${factory} and automation = ${automation}
    limit 1
  `) as ScheduleRow[];
  return rows[0] ? mapSchedule(rows[0]) : null;
}

/**
 * Records one fire. `(schedule_id, fire_at)` is the idempotency key, so a replayed
 * Temporal schedule fire (or a retried activity) never creates a second work item.
 */
export async function recordAutomationFire(
  sql: SQL,
  args: {
    scheduleId: string;
    fireAt: string;
    factory: string;
    automation: string;
    workItemId?: string | null;
    skipped?: boolean;
    reason?: string | null;
  },
): Promise<{ fire: AutomationFireRecord | null; duplicate: boolean }> {
  const rows = (await sql`
    insert into automation_fires (
      schedule_id, fire_at, factory, automation, work_item_id, skipped, reason
    ) values (
      ${args.scheduleId}, ${args.fireAt}::timestamptz, ${args.factory}, ${args.automation},
      ${args.workItemId ?? null}, ${args.skipped ?? false}, ${args.reason ?? null}
    )
    on conflict (schedule_id, fire_at) do nothing
    returning *
  `) as FireRow[];

  if (rows[0]) {
    await sql`
      update automation_schedules set
        last_fire_at = ${args.fireAt}::timestamptz,
        last_work_item_id = coalesce(${args.workItemId ?? null}, last_work_item_id),
        fire_count = fire_count + 1,
        updated_at = now()
      where id = ${args.scheduleId}
    `;
    return { fire: mapFire(rows[0]), duplicate: false };
  }
  return { fire: null, duplicate: true };
}

/** Attaches the created work item to the fire row (the item id is derived after the fire). */
export async function setAutomationFireWorkItem(
  sql: SQL,
  args: { scheduleId: string; fireAt: string; workItemId: string },
): Promise<void> {
  await sql`
    update automation_fires set work_item_id = ${args.workItemId}
    where schedule_id = ${args.scheduleId} and fire_at = ${args.fireAt}::timestamptz
  `;
}

export async function listAutomationFires(
  sql: SQL,
  scheduleId: string,
  limit = 20,
): Promise<AutomationFireRecord[]> {
  const rows = (await sql`
    select * from automation_fires
    where schedule_id = ${scheduleId}
    order by fire_at desc
    limit ${Math.min(Math.max(limit, 1), 100)}
  `) as FireRow[];
  return rows.map(mapFire);
}
