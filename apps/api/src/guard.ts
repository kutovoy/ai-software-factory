import { DEFAULT_GUARD_CONFIG, loadDefinition, type GuardConfig } from '@factory/core';
import { getSql, parseJsonb } from '@factory/orchestration';
import type { ApiConfig } from './config';
import { definitionInvalid } from './errors';
import { resolveFactoryDir } from './factories';

/**
 * `GET /factories/:factoryId/guard-hooks` (spec `guard-hooks`, roadmap item 4).
 *
 * Returns the resolved guard configuration (declared config + defaults) and the newest
 * `guard.checked` / `guard.failed` events, so the console can show why a PR was refused
 * before it was ever committed.
 */

export interface GuardHookEvent {
  workItemId: string;
  type: string;
  stage: string | null;
  actor: string | null;
  payload: Record<string, unknown>;
  createdAt: string | null;
}

export interface GuardHooksView {
  factory: string;
  /** The factory's declared guard block (empty object when absent). */
  config: GuardConfig;
  /** Defaults applied to every unset field. */
  defaults: typeof DEFAULT_GUARD_CONFIG;
  recent: GuardHookEvent[];
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export async function getGuardHooksForApi(
  config: ApiConfig,
  factory: string,
): Promise<GuardHooksView> {
  const dir = resolveFactoryDir(config, factory);
  const { definition, errors } = loadDefinition(dir, { requireFactoryId: true });
  if (!definition) throw definitionInvalid(factory, errors);

  const sql = getSql();
  const rows = (await sql`
    select e.work_item_id, e.type, e.stage, e.actor, e.payload, e.created_at
    from work_item_events e
    join work_items w on w.id = e.work_item_id
    where w.factory = ${factory}
      and e.type in ('guard.checked', 'guard.failed')
    order by e.created_at desc
    limit 20
  `) as {
    work_item_id: string;
    type: string;
    stage: string | null;
    actor: string | null;
    payload: unknown;
    created_at: unknown;
  }[];

  return {
    factory,
    config: definition.manifest.guard ?? {},
    defaults: DEFAULT_GUARD_CONFIG,
    recent: rows.map((row) => ({
      workItemId: row.work_item_id,
      type: row.type,
      stage: row.stage,
      actor: row.actor,
      payload: parseJsonb<Record<string, unknown>>(row.payload, {}),
      createdAt: iso(row.created_at),
    })),
  };
}
