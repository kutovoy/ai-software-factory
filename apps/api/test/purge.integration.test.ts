import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { createUser, newFactoryId, newWorkItemId } from '@factory/core';
import {
  closeClient,
  getClient,
  getSql,
  setSql,
  type OrchestrationConfig,
} from '@factory/orchestration';
import { factoryIdOf, req } from './helpers';
import { createApp } from '../src/app';
import { toOrchestrationConfig, loadApiConfig, type ApiConfig } from '../src/config';

/**
 * Factory purge integration (change `fix-factory-purge`, tasks 1.1–1.6).
 *
 * Opt-in like the other integration suites:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory_test \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test apps/api/test/purge.integration.test.ts
 *
 * Exercises the real DELETE route against Postgres and Temporal: one transaction over
 * every factory-scoped table, schedule deletion, running-workflow termination, run-dir
 * removal, the active-work refusal, the 404 for a foreign factory and the fail-closed
 * behaviour with an unreachable database.
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');
const PREFIX = `purge-itest-${process.pid}`;
const FIXTURE_ROOT = join(REPO_ROOT, 'runs', '.purge-itest');
const RUNS_DIR = join(FIXTURE_ROOT, 'runs');
/** Legacy top-level factory, purged by the tests. */
const FACTORY_KEY = `${PREFIX}-factory`;
/** Second factory used only for the owner/admin 404 check. */
const OTHER_KEY = `${PREFIX}-other`;
const ADMIN_EMAIL = `${PREFIX}-admin@factory.local`;
const ADMIN_PASSWORD = 'itest-admin-pass';
const MEMBER_EMAIL = `${PREFIX}-member@factory.local`;
const MEMBER_PASSWORD = 'itest-member-pass';

const DEFINITION_COMMIT = 'e67bd6f7f28e93babc694d1f0b73fd99364aeaa5';

let config: ApiConfig;
let app: Hono;
let authApp: Hono;
let sql: SQL;
let orchestration: OrchestrationConfig;
let factoryId: string;
let otherFactoryId: string;

async function migrate(databaseUrl: string): Promise<void> {
  const runner = new SQL(databaseUrl, { max: 1 });
  try {
    await runner`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = new Set(
      ((await runner`select name from schema_migrations`) as { name: string }[]).map((row) => row.name),
    );
    const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await runner.unsafe(await readFile(join(MIGRATIONS, file), 'utf8'));
      await runner`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
  } finally {
    await runner.close();
  }
}

/** Copies `factories/example` under a scratch root and mints a fresh identity. */
async function copyFactory(key: string): Promise<void> {
  const dir = join(FIXTURE_ROOT, key);
  await cp(join(REPO_ROOT, 'factories', 'example'), dir, { recursive: true });
  const manifest = join(dir, 'factory.yaml');
  const yaml = await readFile(manifest, 'utf8');
  await writeFile(manifest, yaml.replace(/^id: .*$/m, `id: ${newFactoryId()}`));
}

function sessionCookie(response: Response): string | null {
  const raw = response.headers.get('set-cookie');
  const match = raw ? /factory_session=([^;]*)/.exec(raw) : null;
  return match?.[1] ? `factory_session=${match[1]}` : null;
}

async function login(email: string, password: string): Promise<string> {
  const response = await req(authApp, '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  const cookie = sessionCookie(response);
  if (!cookie) throw new Error('login returned no session cookie');
  return cookie;
}

async function seedWorkItem(
  id: string,
  status: string,
  workflowId: string | null = null,
): Promise<void> {
  await sql`
    insert into work_items (
      id, factory, factory_id, type, source, title, stage, status, definition_commit, workflow_id
    ) values (
      ${id}, ${FACTORY_KEY}, ${factoryId}, 'task', 'manual', 'Purge integration item',
      'triage', ${status}, ${DEFINITION_COMMIT}, ${workflowId}
    )
  `;
}

async function seedRun(
  runId: string,
  status: string,
  workflowId: string,
  workItemId: string,
): Promise<void> {
  await sql`
    insert into runs (
      id, factory, factory_id, definition_commit, definition_dirty, harness, runner, kind,
      input, status, workflow_id, started_at
    ) values (
      ${runId}, ${FACTORY_KEY}, ${factoryId}, ${DEFINITION_COMMIT}, false, 'fake',
      'fake', 'run', ${{ workItemId }}::jsonb, ${status}, ${workflowId}, now()
    )
  `;
  await sql`
    insert into events (run_id, seq, type, ts, payload)
    values (${runId}, 1, 'run.started', ${Date.now()}, ${({ runId })}::jsonb)
  `;
  await mkdir(join(RUNS_DIR, runId), { recursive: true });
  await writeFile(join(RUNS_DIR, runId, 'events.jsonl'), '{}\n');
}

async function createSchedules(): Promise<string[]> {
  const client = await getClient(orchestration);
  const ids = [`automation-${FACTORY_KEY}-nightly`, `scoring-${FACTORY_KEY}`];
  for (const scheduleId of ids) {
    await client.schedule.create({
      scheduleId,
      spec: { cronExpressions: ['0 3 * * *'] },
      action: {
        type: 'startWorkflow',
        workflowType: 'FactoryWorkflow',
        taskQueue: orchestration.taskQueue,
        args: [{ factory: FACTORY_KEY }],
      },
    });
  }
  return ids;
}

async function startWorkflow(workflowId: string, workflowType: string): Promise<void> {
  const client = await getClient(orchestration);
  await client.workflow.start(workflowType, {
    taskQueue: orchestration.taskQueue,
    workflowId,
    args: [{ factory: FACTORY_KEY, workflowId }],
  });
}

async function workflowStatus(workflowId: string): Promise<string> {
  const client = await getClient(orchestration);
  const description = await client.workflow.getHandle(workflowId).describe();
  return description.status.name;
}

async function scheduleExists(scheduleId: string): Promise<boolean> {
  const client = await getClient(orchestration);
  try {
    await client.schedule.getHandle(scheduleId).describe();
    return true;
  } catch {
    return false;
  }
}

async function count(table: string, column: string, value: string): Promise<number> {
  const rows = (await sql.unsafe(
    `select count(*)::int as count from "${table}" where "${column}" = $1`,
    [value],
  )) as { count: number | string }[];
  return Number(rows[0]?.count ?? 0);
}

suite('factory purge API', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL as string;
    process.env.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS as string;
    process.env.TEMPORAL_TASK_QUEUE = `factory-api-purge-itest-${process.pid}-${Date.now()}`;
    process.env.FACTORY_ROOT = FIXTURE_ROOT;
    process.env.REPO_ROOT = REPO_ROOT;
    process.env.RUNS_DIR = RUNS_DIR;

    await rm(FIXTURE_ROOT, { recursive: true, force: true });
    await mkdir(RUNS_DIR, { recursive: true });
    await copyFactory(FACTORY_KEY);
    await copyFactory(OTHER_KEY);

    await migrate(process.env.DATABASE_URL as string);
    sql = new SQL(process.env.DATABASE_URL as string, { max: 1 });
    await sql`delete from users where username like ${`${PREFIX}%`}`;

    config = loadApiConfig({
      ...process.env,
      AUTH_REQUIRED: '0',
      GITHUB_API_BASE_URL: '',
      GITHUB_TOKEN: '',
    });
    orchestration = toOrchestrationConfig(config);

    app = createApp(config);
    factoryId = await factoryIdOf(app, FACTORY_KEY);

    const admin = await createUser(sql, {
      email: ADMIN_EMAIL,
      username: `${PREFIX}-admin`,
      name: 'Purge Admin',
      password: ADMIN_PASSWORD,
      role: 'admin',
    });
    await createUser(sql, {
      email: MEMBER_EMAIL,
      username: `${PREFIX}-member`,
      name: 'Purge Member',
      password: MEMBER_PASSWORD,
      role: 'member',
    });
    authApp = createApp({ ...config, authRequired: true });
    otherFactoryId = await factoryIdOf(
      authApp,
      OTHER_KEY,
      await login(ADMIN_EMAIL, ADMIN_PASSWORD),
    );
    expect(admin.role).toBe('admin');
  }, 120_000);

  afterAll(async () => {
    const db = getSql();
    for (const key of [FACTORY_KEY, OTHER_KEY]) {
      await db`delete from runs where factory = ${key}`;
      await db`delete from work_items where factory = ${key}`;
      await db`delete from factories where key = ${key}`;
    }
    await db`delete from users where username like ${`${PREFIX}%`}`;
    await sql.close();
    await rm(FIXTURE_ROOT, { recursive: true, force: true });
    await closeClient();
  }, 60_000);

  test('an unreachable database fails closed with 503 and deletes nothing', async () => {
    const before = await count('work_items', 'factory', FACTORY_KEY);
    const workItemId = newWorkItemId();
    await seedWorkItem(workItemId, 'done');

    // Point the shared SQL singleton at an unreachable port; the route must abort before
    // touching Temporal or the database.
    setSql(null);
    const brokenApp = createApp({
      ...config,
      databaseUrl: 'postgres://factory:factory@127.0.0.1:1/factory',
    });
    const response = await req(brokenApp, `/factories/${factoryId}`, { method: 'DELETE' });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('database_unavailable');

    // Restore the good connection for the remaining tests.
    setSql(null);
    createApp(config);
    expect(await count('work_items', 'factory', FACTORY_KEY)).toBe(before + 1);
    await sql`delete from work_items where id = ${workItemId}`;
  }, 60_000);

  test('active work items and pending runs are refused without force', async () => {
    const workItemId = newWorkItemId();
    const runId = `run_${workItemId}_triage_1`;
    await seedWorkItem(workItemId, 'active', `factory-${workItemId}`);
    await seedRun(runId, 'pending', `run-${runId}`, workItemId);
    const schedules = await createSchedules();

    const response = await req(app, `/factories/${factoryId}`, { method: 'DELETE' });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; details: { workItems: string[] } };
    expect(body.code).toBe('factory_has_active_work');
    expect(body.details.workItems).toContain(workItemId);

    // Nothing was touched: rows, schedule and run directory survive the refusal.
    expect(await count('work_items', 'factory', FACTORY_KEY)).toBe(1);
    expect(await count('runs', 'factory', FACTORY_KEY)).toBe(1);
    expect(await scheduleExists(schedules[0] as string)).toBe(true);
    expect(existsSync(join(RUNS_DIR, runId))).toBe(true);

    // The dry run reports the same active work without refusing.
    const dryRun = await req(app, `/factories/${factoryId}?dryRun=1`, { method: 'DELETE' });
    expect(dryRun.status).toBe(200);
    const plan = (await dryRun.json()) as {
      dryRun: boolean;
      forceRequired: boolean;
      plan: { rows: number; schedules: string[]; runDirs: string[] };
    };
    expect(plan.dryRun).toBe(true);
    expect(plan.forceRequired).toBe(true);
    expect(plan.plan.rows).toBeGreaterThanOrEqual(2);
    expect(plan.plan.schedules).toContain(schedules[0] as string);
    expect(plan.plan.runDirs).toContain(join(RUNS_DIR, runId));
    expect(await count('work_items', 'factory', FACTORY_KEY)).toBe(1);
  }, 120_000);

  test('purge deletes rows, registry, schedules, running workflows and run dirs', async () => {
    // The previous test left one active item and one pending run with live workflows.
    const [item] = (await sql`
      select id from work_items where factory = ${FACTORY_KEY}
    `) as { id: string }[];
    const [run] = (await sql`
      select id from runs where factory = ${FACTORY_KEY}
    `) as { id: string }[];
    const itemId = item?.id as string;
    const runId = run?.id as string;
    const itemWorkflowId = `factory-${itemId}`;
    const runWorkflowId = `run-${runId}`;

    await startWorkflow(itemWorkflowId, 'FactoryWorkflow');
    await startWorkflow(runWorkflowId, 'RunWorkflow');
    expect(await workflowStatus(itemWorkflowId)).toBe('RUNNING');
    expect(await workflowStatus(runWorkflowId)).toBe('RUNNING');

    const scheduleIds = [`automation-${FACTORY_KEY}-nightly`, `scoring-${FACTORY_KEY}`];
    const response = await req(app, `/factories/${factoryId}?force=1`, { method: 'DELETE' });
    expect(response.status).toBe(200);

    const report = (await response.json()) as {
      factoryId: string;
      factory: string;
      dryRun: boolean;
      deleted: { tables: Record<string, number>; rows: number };
      schedules: string[];
      workflows: string[];
      runDirs: string[];
      failures: unknown[];
      kept: { gitHistory: boolean; forge: boolean };
    };
    expect(report.factoryId).toBe(factoryId);
    expect(report.factory).toBe(FACTORY_KEY);
    expect(report.dryRun).toBe(false);
    expect(report.deleted.tables.work_items).toBe(1);
    expect(report.deleted.tables.runs).toBe(1);
    expect(report.deleted.tables.factories).toBe(1);
    expect(report.deleted.rows).toBeGreaterThanOrEqual(3);
    expect(report.schedules).toEqual(expect.arrayContaining(scheduleIds));
    expect(report.workflows).toEqual(expect.arrayContaining([itemWorkflowId, runWorkflowId]));
    expect(report.runDirs).toContain(join(RUNS_DIR, runId));
    expect(report.failures).toEqual([]);
    expect(report.kept).toEqual({ gitHistory: true, forge: true });

    // Every factory-scoped row is gone, including the registry row and child rows.
    expect(await count('work_items', 'factory', FACTORY_KEY)).toBe(0);
    expect(await count('runs', 'factory', FACTORY_KEY)).toBe(0);
    expect(await count('work_item_events', 'work_item_id', itemId)).toBe(0);
    expect(await count('events', 'run_id', runId)).toBe(0);
    expect(await count('factories', 'id', factoryId)).toBe(0);

    // Temporal: schedules deleted, workflows terminated (histories remain, by design).
    for (const scheduleId of scheduleIds) expect(await scheduleExists(scheduleId)).toBe(false);
    expect(await workflowStatus(itemWorkflowId)).toBe('TERMINATED');
    expect(await workflowStatus(runWorkflowId)).toBe('TERMINATED');

    // Artifacts removed, the git-backed definition directory kept.
    expect(existsSync(join(RUNS_DIR, runId))).toBe(false);
    expect(existsSync(join(FIXTURE_ROOT, FACTORY_KEY, 'factory.yaml'))).toBe(true);
  }, 120_000);

  test('a member cannot purge a factory they do not own (404, nothing deleted)', async () => {
    const memberCookie = await login(MEMBER_EMAIL, MEMBER_PASSWORD);
    const response = await req(authApp, `/factories/${otherFactoryId}`, {
      method: 'DELETE',
      headers: { cookie: memberCookie },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('factory_not_found');

    // The admin-owned factory is still registered and addressable by its admin.
    expect(await count('factories', 'id', otherFactoryId)).toBe(1);
  }, 60_000);
});
