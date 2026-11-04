import { existsSync, rmSync } from 'node:fs';
import {
  getClient,
  getSql,
  pingDb,
  runDir,
  temporalHealthy,
  temporalScheduleIdFor,
  workflowIdFor,
  workItemWorkflowId,
} from '@factory/orchestration';
import { automationSpecsFromDefinition } from './automations';
import { resolveFactoryDir, type FactoryRecord } from './factories';
import type { ApiConfig } from './config';
import { toOrchestrationConfig } from './config';
import { ApiError } from './errors';
import { log } from './logger';

/**
 * Factory purge (change `fix-factory-purge`, spec `factory-purge`).
 *
 * Deleting a factory must leave **no** application state behind: a reused name must not
 * resurrect old work items, runs, events or schedules. The purge lives in the API because
 * only the API owns the database, the Temporal client and the `runs/<id>/` artifacts.
 *
 * Invariants:
 *  - **Fail closed.** A database or Temporal outage aborts before anything is deleted; a
 *    silently skipped cleanup is what produced the stale `hello-nextjs` rows.
 *  - **One transaction.** Every table with a `factory` column is deleted by the internal
 *    key, child rows cascade, the `factories` registry row is removed last, and a
 *    verification pass rolls the transaction back when a single row survives.
 *  - **Temporal.** Schedules belonging to the factory are deleted and the workflows of
 *    non-terminal runs/work items are terminated. Closed histories remain until Temporal
 *    retention; that limitation is deliberate and reported, not hidden.
 *  - **Artifacts.** Run ids are collected before the DB delete, then `runs/<id>/` is
 *    removed after the commit. Git history and the forge repository/PRs are kept.
 */

/** Work-item statuses that still represent live work (refused without `force`). */
const ACTIVE_WORK_ITEM_STATUSES = ['active', 'blocked', 'escalated'] as const;
/** Run statuses that still represent live work (refused without `force`). */
const ACTIVE_RUN_STATUSES = ['pending', 'running'] as const;

/** Child tables without a `factory` column, verified through their parent ids. */
const RUN_CHILD_TABLES = [
  'run_steps',
  'events',
  'run_permissions',
  'proxy_tokens',
  'proxy_attempts',
  'run_secrets',
] as const;
const WORK_ITEM_CHILD_TABLES = ['work_item_events', 'gate_decisions'] as const;

export interface PurgeOptions {
  /** Delete even when the factory still has active work items or running runs. */
  force?: boolean;
  /** Report the plan without deleting anything. */
  dryRun?: boolean;
}

export interface PurgeFailure {
  step: 'schedule' | 'workflow' | 'runDir';
  id: string;
  error: string;
}

export interface FactoryPurgeReport {
  factoryId: string;
  /** Internal key (`<name>` or `<owner>/<name>`) used by every existing table. */
  factory: string;
  dryRun: boolean;
  /** Rows removed per table; `rows` is the total including `run_secrets`/`factories`. */
  deleted: { tables: Record<string, number>; rows: number };
  schedules: string[];
  workflows: string[];
  runDirs: string[];
  failures: PurgeFailure[];
  activeWork: { workItems: number; runs: number };
  /** True when active work exists and `force` was not set (a dry run only reports it). */
  forceRequired: boolean;
  kept: { gitHistory: true; forge: true };
  /** Dry-run plan: what a real purge would remove. */
  plan?: {
    tables: Record<string, number>;
    rows: number;
    schedules: string[];
    workflows: string[];
    runDirs: string[];
  };
}

interface WorkItemRow {
  id: string;
  status: string;
  workflow_id: string | null;
}

interface RunRow {
  id: string;
  status: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A Temporal `NotFound` / already-finished execution is not a purge failure. */
function isGone(error: unknown): boolean {
  return /not found|notfound|not_found|already completed|already terminated|already finished|no workflow/i.test(
    messageOf(error),
  );
}

/**
 * Probes both dependencies before any mutation. A missing database or Temporal server is a
 * `503` and nothing is touched (design decision 2: fail closed).
 */async function assertInfrastructure(config: ApiConfig): Promise<void> {
  try {
    await pingDb(config.databaseUrl);
  } catch (error) {
    throw new ApiError(
      'database_unavailable',
      503,
      'the purge needs a reachable database; nothing was deleted',
      { error: messageOf(error) },
    );
  }

  const temporal = await temporalHealthy(toOrchestrationConfig(config));
  if (!temporal.ok) {
    throw new ApiError(
      'temporal_unavailable',
      503,
      'the purge needs a reachable Temporal server; nothing was deleted',
      { address: temporal.address, error: temporal.error ?? 'unhealthy' },
    );
  }
}

/** Every base table that carries a `factory` text column (the read-model surface). */
async function factoryTables(sql: ReturnType<typeof getSql>): Promise<string[]> {
  const rows = (await sql`
    select t.table_name as name
    from information_schema.tables t
    where t.table_schema = 'public'
      and t.table_type = 'BASE TABLE'
      and exists (
        select 1
        from information_schema.columns c
        where c.table_schema = t.table_schema
          and c.table_name = t.table_name
          and c.column_name = 'factory'
      )
    order by t.table_name
  `) as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * True when a Temporal schedule id belongs to `key`.
 *
 * Ids are `scoring-<key>` and `automation-<key>-<automation>`. A factory key may itself
 * contain `-` (and `/`), so a naive prefix match would let purging `hello` delete
 * `automation-hello-nextjs-nightly`. Ownership is resolved against the **longest
 * registered key** that fits the id, exactly.
 */
function ownsScheduleId(scheduleId: string, key: string, keys: string[]): boolean {
  if (scheduleId === `scoring-${key}`) return true;
  const prefix = 'automation-';
  if (!scheduleId.startsWith(prefix)) return false;
  const rest = scheduleId.slice(prefix.length);
  let owner: string | null = null;
  for (const candidate of keys) {
    if (rest.startsWith(`${candidate}-`) && (owner === null || candidate.length > owner.length)) {
      owner = candidate;
    }
  }
  return owner === key;
}

async function countRows(
  sql: ReturnType<typeof getSql>,
  table: string,
  key: string,
): Promise<number> {
  const rows = (await sql.unsafe(
    `select count(*)::int as count from ${quoteIdentifier(table)} where factory = $1`,
    [key],
  )) as { count: number | string }[];
  return Number(rows[0]?.count ?? 0);
}

/** Verifies the purge inside the transaction; throws so `sql.begin` rolls back. */
async function verifyPurged(
  tx: ReturnType<typeof getSql>,
  tables: string[],
  key: string,
  factoryId: string,
  runIds: string[],
  workItemIds: string[],
): Promise<void> {
  for (const table of tables) {
    const remaining = await countRows(tx, table, key);
    if (remaining !== 0) {
      throw new Error(`purge verification failed: "${table}" still has ${remaining} row(s)`);
    }
  }

  const registry = (await tx.unsafe(
    'select count(*)::int as count from factories where id = $1 or key = $2',
    [factoryId, key],
  )) as { count: number | string }[];
  if (Number(registry[0]?.count ?? 0) !== 0) {
    throw new Error('purge verification failed: the factories registry row survived');
  }

  if (runIds.length > 0) {
    const csv = runIds.join(',');
    for (const table of RUN_CHILD_TABLES) {
      const rows = (await tx.unsafe(
        `select count(*)::int as count from ${quoteIdentifier(table)} where run_id = any(string_to_array($1, ','))`,
        [csv],
      )) as { count: number | string }[];
      if (Number(rows[0]?.count ?? 0) !== 0) {
        throw new Error(`purge verification failed: "${table}" still references a deleted run`);
      }
    }
  }

  if (workItemIds.length > 0) {
    const csv = workItemIds.join(',');
    for (const table of WORK_ITEM_CHILD_TABLES) {
      const rows = (await tx.unsafe(
        `select count(*)::int as count from ${quoteIdentifier(table)} where work_item_id = any(string_to_array($1, ','))`,
        [csv],
      )) as { count: number | string }[];
      if (Number(rows[0]?.count ?? 0) !== 0) {
        throw new Error(`purge verification failed: "${table}" still references a deleted work item`);
      }
    }
  }
}

/**
 * Purges one factory. Authorization is already applied by `resolveFactory` (the caller
 * resolves by opaque id for the viewer, so a foreign id is a `404`, never a `403`).
 */
export async function purgeFactoryForApi(
  config: ApiConfig,
  record: FactoryRecord,
  options: PurgeOptions = {},
): Promise<FactoryPurgeReport> {
  const factoryId = record.id;
  if (!factoryId) {
    throw new ApiError(
      'factory_identity_missing',
      422,
      `factory "${record.key}" has no committed id; run the identity migration first`,
      { factory: record.key },
    );
  }

  const key = record.key;
  const force = options.force === true;
  const dryRun = options.dryRun === true;

  // Fail closed: nothing below runs when the database or Temporal is unreachable.
  await assertInfrastructure(config);

  const sql = getSql();

  const workItems = (await sql`
    select id, status, workflow_id from work_items where factory = ${key}
  `) as WorkItemRow[];
  const runs = (await sql`
    select id, status from runs where factory = ${key}
  `) as RunRow[];

  const activeWorkItems = workItems.filter((item) =>
    (ACTIVE_WORK_ITEM_STATUSES as readonly string[]).includes(item.status),
  );
  const activeRuns = runs.filter((run) =>
    (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status),
  );
  const activeWork = { workItems: activeWorkItems.length, runs: activeRuns.length };
  const forceRequired = activeWork.workItems > 0 || activeWork.runs > 0;

  if (forceRequired && !force && !dryRun) {
    throw new ApiError(
      'factory_has_active_work',
      409,
      `factory "${key}" still has ${activeWork.workItems} active work item(s) and ${activeWork.runs} running run(s); cancel them or re-run with force`,
      {
        factory: key,
        ...activeWork,
        workItems: activeWorkItems.map((item) => item.id),
        runs: activeRuns.map((run) => run.id),
      },
    );
  }

  // Collect everything the purge needs **before** the DB delete.
  const runIds = runs.map((run) => run.id);
  const workItemIds = workItems.map((item) => item.id);

  const automationRows = (await sql`
    select automation, temporal_schedule_id from automation_schedules where factory = ${key}
  `) as { automation: string; temporal_schedule_id: string | null }[];
  const scheduleIds = new Set<string>([`scoring-${key}`]);
  for (const row of automationRows) {
    scheduleIds.add(row.temporal_schedule_id ?? temporalScheduleIdFor(key, row.automation));
  }

  // The git-backed definition is authoritative for automation names; the DB rows above are
  // its projection. An invalid definition must not block the purge.
  try {
    for (const spec of automationSpecsFromDefinition(resolveFactoryDir(config, key), key)) {
      scheduleIds.add(temporalScheduleIdFor(key, spec.name));
    }
  } catch {
    // Fall through: DB rows and the Temporal listing still cover the schedules.
  }

  // Temporal owns schedules the read model may not have recorded (e.g. a scoring schedule
  // created before a migration). List them and keep only the ones this factory owns.
  const client = await getClient(toOrchestrationConfig(config));
  const registryKeys = (
    (await sql`select key from factories`) as { key: string }[]
  ).map((row) => row.key);
  if (!registryKeys.includes(key)) registryKeys.push(key);
  try {
    let seen = 0;
    for await (const summary of client.schedule.list()) {
      if (ownsScheduleId(summary.scheduleId, key, registryKeys)) {
        scheduleIds.add(summary.scheduleId);
      }
      if (++seen >= 5000) break;
    }
  } catch (error) {
    // Listing is a safety net; the derived ids above are enough to purge this factory.
    log('warn', 'factory_purge_schedule_list_failed', { factory: key, error: messageOf(error) });
  }

  // Only non-terminal executions can be running; terminating a finished workflow is a
  // no-op that Temporal reports as "already completed" (treated as gone, not a failure).
  const workflowIds = new Set<string>();
  for (const run of activeRuns) workflowIds.add(workflowIdFor(run.id));
  for (const item of activeWorkItems) {
    workflowIds.add(item.workflow_id ?? workItemWorkflowId(item.id));
  }

  const runDirs = runIds
    .map((runId) => runDir(config.runsDir, runId))
    .filter((dir) => existsSync(dir));

  const tables = await factoryTables(sql);
  const plannedTables: Record<string, number> = {};
  for (const table of tables) plannedTables[table] = await countRows(sql, table, key);
  const plannedRows = Object.values(plannedTables).reduce((sum, count) => sum + count, 0);

  if (dryRun) {
    log('info', 'factory_purge_planned', {
      factory: key,
      factoryId,
      tables: plannedRows,
      schedules: scheduleIds.size,
      workflows: workflowIds.size,
      runDirs: runDirs.length,
    });
    return {
      factoryId,
      factory: key,
      dryRun: true,
      deleted: { tables: {}, rows: 0 },
      schedules: [],
      workflows: [],
      runDirs: [],
      failures: [],
      activeWork,
      forceRequired,
      kept: { gitHistory: true, forge: true },
      plan: {
        tables: plannedTables,
        rows: plannedRows,
        schedules: [...scheduleIds],
        workflows: [...workflowIds],
        runDirs,
      },
    };
  }

  const failures: PurgeFailure[] = [];
  const schedules: string[] = [];
  const workflows: string[] = [];

  // Temporal first: delete schedules so nothing re-creates work, then terminate the
  // executions that are still running. Closed histories stay until Temporal retention.
  for (const scheduleId of scheduleIds) {
    try {
      await client.schedule.getHandle(scheduleId).delete();
      schedules.push(scheduleId);
    } catch (error) {
      if (isGone(error)) continue;
      failures.push({ step: 'schedule', id: scheduleId, error: messageOf(error) });
    }
  }
  for (const workflowId of workflowIds) {
    try {
      await client.workflow
        .getHandle(workflowId)
        .terminate(`factory "${key}" was purged`);
      workflows.push(workflowId);
    } catch (error) {
      if (isGone(error)) continue;
      failures.push({ step: 'workflow', id: workflowId, error: messageOf(error) });
    }
  }

  let deleted: { tables: Record<string, number>; rows: number };
  try {
    deleted = await sql.begin(async (tx) => {
      const counts: Record<string, number> = {};
      for (const table of tables) {
        const rows = (await tx.unsafe(
          `delete from ${quoteIdentifier(table)} where factory = $1 returning 1`,
          [key],
        )) as unknown[];
        counts[table] = rows.length;
      }

      // `run_secrets` is run-scoped and has no FK to `runs` (secrets are metadata only),
      // so it needs an explicit delete by the collected run ids.
      if (runIds.length > 0) {
        const rows = (await tx.unsafe(
          `delete from run_secrets where run_id = any(string_to_array($1, ',')) returning 1`,
          [runIds.join(',')],
        )) as unknown[];
        counts.run_secrets = rows.length;
      }

      // The registry row goes last: while it exists the factory is still addressable.
      const registry = (await tx.unsafe(
        'delete from factories where id = $1 or key = $2 returning 1',
        [factoryId, key],
      )) as unknown[];
      counts.factories = registry.length;

      await verifyPurged(tx, tables, key, factoryId, runIds, workItemIds);

      return {
        tables: counts,
        rows: Object.values(counts).reduce((sum, count) => sum + count, 0),
      };
    });
  } catch (error) {
    throw new ApiError(
      'factory_purge_failed',
      500,
      'the database purge failed and was rolled back; database rows are unchanged ' +
        `(Temporal schedules/workflows may already be removed): ${messageOf(error)}`,
      { factory: key, factoryId, error: messageOf(error) },
    );
  }

  // Artifacts after the commit: a failed rollback must never lose run directories.
  const removedRunDirs: string[] = [];
  for (const dir of runDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
      removedRunDirs.push(dir);
    } catch (error) {
      failures.push({ step: 'runDir', id: dir, error: messageOf(error) });
    }
  }

  log('info', 'factory_purged', {
    factory: key,
    factoryId,
    rows: deleted.rows,
    tables: Object.keys(deleted.tables).length,
    schedules: schedules.length,
    workflows: workflows.length,
    runDirs: removedRunDirs.length,
    failures: failures.length,
  });

  return {
    factoryId,
    factory: key,
    dryRun: false,
    deleted,
    schedules,
    workflows,
    runDirs: removedRunDirs,
    failures,
    activeWork,
    forceRequired,
    kept: { gitHistory: true, forge: true },
  };
}
