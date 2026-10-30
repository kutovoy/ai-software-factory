import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Worker } from '@temporalio/worker';
import {
  createVersion,
  derivedWorkItemId,
  getAutomationSchedule,
  getWorkItem,
  listAutomationFires,
  listWorkItemEvents,
  loadDefinition,
  recordBenchmarkAttestation,
} from '@factory/core';
import { benchmarkConfigHash, loadBenchmarkSuites } from '@factory/evals';
import { FakeForge } from '@factory/forge';
import { WorkflowIdReusePolicy } from '@temporalio/client';
import { closeClient, getClient } from '../src/client';
import { closeSql, getSql, setSql } from '../src/db';
import { loadConfig, type OrchestrationConfig } from '../src/config';
import { setForge } from '../src/activities/forge';
import { clearEphemeralLeases } from '../src/activities/runner';
import { clearSessions } from '../src/sessions';
import { createWorker } from '../src/worker';
import {
  describeAutomationSchedule,
  pauseAutomationSchedule,
  syncAutomationSchedules,
} from '../src/automation-client';
import { automationWorkflowId, type AutomationWorkflowInput } from '../src/types';
import { fireAutomationActivity } from '../src/activities/automation';

/**
 * Scheduled automations (spec `automations` › scheduled automations).
 *
 * Opt-in (needs Temporal + Postgres):
 *
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test packages/orchestration/test/automation.integration.test.ts
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const FACTORY = 'example';
const FACTORY_ROOT = join(REPO_ROOT, 'factories', FACTORY);
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');
const REPO = { owner: 'acme', name: 'api-service' };
const AUTOMATION = 'nightly';

let config: OrchestrationConfig;
let worker: Worker;
let running: Promise<void>;

async function migrate(databaseUrl: string): Promise<void> {
  const sql = new SQL(databaseUrl, { max: 1 });
  try {
    // Mirrors `scripts/migrate.ts`: apply each file once (recorded in schema_migrations).
    // Re-running every file against a dirty database would recreate indexes over data
    // that violates them (the compose database is shared across suites).
    await sql`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = new Set(
      ((await sql`select name from schema_migrations`) as { name: string }[]).map((row) => row.name),
    );
    const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await sql.unsafe(await readFile(join(MIGRATIONS, file), 'utf8'));
      await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
  } finally {
    await sql.close();
  }
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function runFire(fireAt: string, suffix = ''): Promise<{ workflowId: string }> {
  const client = await getClient(config);
  const input: AutomationWorkflowInput = {
    factory: FACTORY,
    factoryRoot: FACTORY_ROOT,
    automation: AUTOMATION,
    scheduleId: `${FACTORY}:${AUTOMATION}`,
    cron: '0 3 * * *',
    fireAt,
    harness: 'fake',
    runner: 'fake',
  };
  const workflowId = `${automationWorkflowId(input.scheduleId, fireAt)}${suffix}`;
  await client.workflow.start('AutomationWorkflow', {
    taskQueue: config.taskQueue,
    workflowId,
    args: [input],
    workflowExecutionTimeout: '1 hour',
    // The same fire timestamp maps to the same workflow id; a replayed fire reuses it.
    workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
  });
  return { workflowId };
}

suite('scheduled automations', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL as string;
    process.env.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS as string;
    process.env.TEMPORAL_TASK_QUEUE = `factory-auto-itest-${process.pid}-${Date.now()}`;
    process.env.FACTORY_ROOT = join(REPO_ROOT, 'factories');
    process.env.REPO_ROOT = REPO_ROOT;
    process.env.RUNS_DIR = join(REPO_ROOT, 'runs');

    await migrate(process.env.DATABASE_URL as string);
    config = loadConfig();
    setSql(new SQL(config.databaseUrl, { max: 4 }));

    const forge = new FakeForge();
    forge.seedRepo(REPO, { 'README.md': '# api-service\n' });
    setForge('fake', forge);

    worker = await createWorker(config);
    running = worker.run();
    void running.catch(() => undefined);
  }, 90_000);

  afterAll(async () => {
    try {
      const client = await getClient(config);
      await client.schedule.getHandle(`automation-${FACTORY}-${AUTOMATION}`).delete();
    } catch {
      // not created in this run
    }
    await worker?.shutdown();
    await closeClient();
    await closeSql();
    clearSessions();
    clearEphemeralLeases();
  }, 30_000);

  test('an enabled schedule is created and marked active', async () => {
    const result = await syncAutomationSchedules(
      FACTORY,
      FACTORY_ROOT,
      [{ name: AUTOMATION, enabled: true, cron: '0 3 * * *' }],
      config,
    );
    expect(result.active).toContain(`automation-${FACTORY}-${AUTOMATION}`);
    expect(result.created.length).toBeGreaterThan(0);

    const row = await getAutomationSchedule(getSql(), FACTORY, AUTOMATION);
    expect(row?.status).toBe('active');
    expect(row?.cron).toBe('0 3 * * *');

    const described = await describeAutomationSchedule(FACTORY, AUTOMATION, config);
    expect(described?.paused).toBe(false);
    expect(described?.scheduleId).toBe(`automation-${FACTORY}-${AUTOMATION}`);
  }, 60_000);

  test('a fire creates a work item once; the same fire timestamp is idempotent', async () => {
    // A unique timestamp keeps the workflow id free of stale runs from earlier test runs.
    const fireAt = new Date().toISOString();
    await runFire(fireAt);

    // The work item id is derived from the fire key, so the test can address it directly
    // (a replayed fire must target the same row).
    const expectedId = derivedWorkItemId(`${FACTORY}:${AUTOMATION}@${fireAt}`);
    const workItemId = await waitFor('the scheduled work item', async () => {
      const rows = await getSql()`
        select id from work_items where id = ${expectedId} limit 1
      `;
      return (rows[0]?.id as string | undefined) ?? null;
    });

    const item = await getWorkItem(getSql(), workItemId);
    expect(item?.source).toBe('cron');
    expect(item?.sourceRef).toMatchObject({
      kind: 'schedule',
      automation: AUTOMATION,
      cron: '0 3 * * *',
      fireAt,
    });

    const events = await listWorkItemEvents(getSql(), workItemId);
    expect(events.some((event) => event.type === 'work_item.created')).toBe(true);

    const fires = await listAutomationFires(getSql(), `${FACTORY}:${AUTOMATION}`);
    expect(fires.some((fire) => fire.workItemId === workItemId && !fire.skipped)).toBe(true);

    // Same schedule id + timestamp (a replayed fire, new workflow run): the activity
    // dedupes it, so no second work item is created.
    await runFire(fireAt, '-replay');
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
    const cronItems = await getSql()`
      select count(*)::int as count from work_items where id = ${expectedId}
    `;
    expect(cronItems[0]?.count).toBe(1);

    const duplicates = await getSql()`
      select count(*)::int as count from automation_fires
      where schedule_id = ${`${FACTORY}:${AUTOMATION}`} and fire_at = ${fireAt}::timestamptz
    `;
    expect(duplicates[0]?.count).toBe(1);
  }, 120_000);

  test('disabling an automation pauses its schedule and stops new work', async () => {
    const result = await syncAutomationSchedules(
      FACTORY,
      FACTORY_ROOT,
      [{ name: AUTOMATION, enabled: false, cron: '0 3 * * *' }],
      config,
    );
    expect(result.paused).toContain(`automation-${FACTORY}-${AUTOMATION}`);

    const row = await getAutomationSchedule(getSql(), FACTORY, AUTOMATION);
    expect(row?.status).toBe('paused');

    const described = await describeAutomationSchedule(FACTORY, AUTOMATION, config);
    expect(described?.paused).toBe(true);
  }, 60_000);

  test('an automation item without a benchmark attestation records autonomy.attestation_missing', async () => {
    const factory = 'example-lights-off';
    const factoryRoot = join(REPO_ROOT, 'factories', factory);
    await getSql()`delete from benchmark_attestations where factory = ${factory}`;
    const fireAt = new Date().toISOString();
    const result = await fireAutomationActivity({
      factory,
      factoryRoot,
      automation: 'intake',
      scheduleId: `${factory}:intake`,
      cron: '0 3 * * *',
      fireAt,
      harness: 'fake',
      runner: 'fake',
    });
    expect(result.created).toBe(true);
    const workItemId = result.workItemId as string;
    const events = await listWorkItemEvents(getSql(), workItemId);
    const missing = events.find((event) => event.type === 'autonomy.attestation_missing');
    expect(missing).toBeDefined();
    expect(missing?.payload).toMatchObject({ factory, automation: 'intake' });
    expect(String(missing?.payload.reason)).toContain('human gates');

    const rows = (await getSql()`
      select input from work_items where id = ${workItemId}
    `) as { input: unknown }[];
    const input = rows[0]?.input as { benchmarkGate?: { required: boolean; satisfied: boolean } };
    expect(input.benchmarkGate?.required).toBe(true);
    expect(input.benchmarkGate?.satisfied).toBe(false);
  }, 90_000);

  test('an automation item with a matching attestation unlocks unattended gates', async () => {
    const factory = 'example-lights-off';
    const factoryRoot = join(REPO_ROOT, 'factories', factory);
    const definition = loadDefinition(factoryRoot).definition;
    expect(definition).toBeDefined();
    const version = createVersion(factoryRoot, { allowDirty: true });
    const suite = loadBenchmarkSuites(definition!)[0];
    expect(suite).toBeDefined();
    const configHash = benchmarkConfigHash(suite!, version.commit);
    await recordBenchmarkAttestation(getSql(), {
      id: `att_itest_${Date.now()}`,
      factory,
      definitionCommit: version.commit,
      suite: suite!.name,
      configHash,
      passRate: 1,
      calibrationOk: true,
      passed: true,
      partial: false,
    });

    const fireAt = new Date().toISOString();
    const result = await fireAutomationActivity({
      factory,
      factoryRoot,
      automation: 'intake',
      scheduleId: `${factory}:intake`,
      cron: '0 3 * * *',
      fireAt,
      harness: 'fake',
      runner: 'fake',
    });
    expect(result.created).toBe(true);
    const workItemId = result.workItemId as string;
    const events = await listWorkItemEvents(getSql(), workItemId);
    expect(events.some((event) => event.type === 'autonomy.attestation_missing')).toBe(false);
    const rows = (await getSql()`
      select input from work_items where id = ${workItemId}
    `) as { input: unknown }[];
    const input = rows[0]?.input as { benchmarkGate?: { required: boolean; satisfied: boolean } };
    expect(input.benchmarkGate).toMatchObject({ required: true, satisfied: true });
  }, 90_000);

  test('pausing one automation records the operator and reason', async () => {
    const row = await pauseAutomationSchedule(
      FACTORY,
      AUTOMATION,
      'operator pause (by itest)',
      config,
    );
    expect(row?.status).toBe('paused');
  }, 60_000);
});
