import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from '@temporalio/worker';
import {
  cancelRun,
  closeClient,
  getClient,
  submitPermissionDecision,
  workflowIdFor,
} from '../src/client';
import {
  closeSql,
  getRun,
  getSql,
  hasPermissionRequest,
  listEvents,
  requestRunCancel,
  setSql,
} from '../src/db';
import { loadConfig, type OrchestrationConfig } from '../src/config';
import { clearEphemeralLeases } from '../src/activities/runner';
import { clearSessions, getSession } from '../src/sessions';
import { createWorker } from '../src/worker';
import type { RunInput } from '../src/types';

/**
 * Integration tests for ADR-013: human permission waits are workflow-level durable waits.
 *
 * They need a real Temporal server and Postgres, so they are opt-in (CI stays service-free):
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test packages/orchestration/test/permissions.integration.test.ts
 *
 * `scripts/smoke-permissions.sh` runs this against the compose stack. The in-process worker
 * deliberately uses **concurrency 2** so the old defect (a permission-blocked run holding an
 * activity slot) would immediately starve the queue.
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');

let config: OrchestrationConfig;
let worker: Worker;
let running: Promise<void>;
let runsDir: string;

async function migrate(databaseUrl: string): Promise<void> {
  const sql = new SQL(databaseUrl, { max: 1 });
  try {
    const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      await sql.unsafe(await readFile(join(MIGRATIONS, file), 'utf8'));
    }
  } finally {
    await sql.close();
  }
}

function runInput(runId: string): RunInput {
  return {
    runId,
    factory: 'example',
    factoryRoot: join(REPO_ROOT, 'factories', 'example'),
    definitionCommit: 'itest',
    definitionDirty: false,
    harness: 'fake',
    model: 'fake/fake-model',
    runner: 'fake',
    prompt: { text: 'permissions integration test' },
    kind: 'chat',
    proxyModels: [],
    fakeDelayMs: 0,
    permissionTimeoutMs: 60_000,
  };
}

async function startRun(runId: string): Promise<void> {
  const client = await getClient(config);
  await client.workflow.start('RunWorkflow', {
    taskQueue: config.taskQueue,
    workflowId: workflowIdFor(runId),
    args: [runInput(runId)],
    workflowExecutionTimeout: '10 minutes',
    workflowTaskTimeout: '30 seconds',
  });
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForPermission(runId: string): Promise<void> {
  await waitFor(`run ${runId} to surface permission per_1`, async () =>
    (await hasPermissionRequest(runId, 'per_1')) ? true : false,
  );
}

async function waitForSessionRelease(runId: string): Promise<void> {
  await waitFor(`run ${runId} to release its runner session`, async () =>
    getSession(runId) === undefined ? true : false,
  );
}

async function waitForStatus(runId: string, status: string): Promise<void> {
  await waitFor(`run ${runId} to reach ${status}`, async () => {
    const run = await getRun(runId);
    return run?.status === status ? true : false;
  });
}

async function decide(runId: string, decision: 'allow' | 'deny' | 'always'): Promise<void> {
  const delivery = await submitPermissionDecision({ runId, requestId: 'per_1', decision }, config);
  expect(delivery.accepted).toBe(true);
}

suite('permission waits are workflow-level durable waits (ADR-013)', () => {
  beforeAll(async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'factory-itest-'));
    // Activities resolve their own config from the environment; point them at this test's
    // scratch run directory before any activity runs.
    process.env.RUNS_DIR = runsDir;
    await migrate(process.env.DATABASE_URL as string);
    setSql(getSql(process.env.DATABASE_URL));

    config = {
      ...loadConfig(),
      taskQueue: `factory-runs-itest-${process.pid}-${Date.now()}`,
      runsDir,
      maxConcurrentActivityTaskExecutions: 2,
      maxConcurrentWorkflowTaskExecutions: 2,
    };

    clearSessions();
    clearEphemeralLeases();
    worker = await createWorker(config);
    running = worker.run();
  }, 60_000);

  afterAll(async () => {
    worker?.shutdown();
    await running?.catch(() => undefined);
    clearSessions();
    clearEphemeralLeases();
    await closeSql();
    await closeClient();
  }, 60_000);

  test('a permission-blocked run does not prevent another run from starting', async () => {
    const blocked = `run_itest_blocked_${Date.now()}`;
    const other = `run_itest_other_${Date.now()}`;

    await startRun(blocked);
    await waitForPermission(blocked);
    expect((await getRun(blocked))?.status).toBe('running');

    // With 2 activity slots, the old implementation would have one slot stuck in the
    // permission poll. The second run must still start, stream and finish.
    await startRun(other);
    await waitForPermission(other);
    await decide(other, 'allow');
    await waitForStatus(other, 'ok');

    // The first run is still waiting, holding no activity slot.
    expect((await getRun(blocked))?.status).toBe('running');

    // The decision path resolves the wait and the run continues to `ok`.
    await decide(blocked, 'allow');
    await waitForStatus(blocked, 'ok');

    const events = await listEvents(blocked, 0, 10_000);
    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === 'permission.requested')).toHaveLength(1);
    expect(types.filter((type) => type === 'run.completed')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed' });
    expect((events.at(-1)?.payload as { status?: string }).status).toBe('ok');
  }, 120_000);

  test('eight blocked runs do not starve a ninth run (concurrency 2)', async () => {
    const blocked: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const runId = `run_itest_8_${index}_${Date.now()}`;
      blocked.push(runId);
      await startRun(runId);
    }
    for (const runId of blocked) await waitForPermission(runId);

    const ninth = `run_itest_ninth_${Date.now()}`;
    await startRun(ninth);
    await waitForPermission(ninth);
    await decide(ninth, 'allow');
    await waitForStatus(ninth, 'ok');

    // All eight are still parked on a human decision, and none of them consumed a slot.
    for (const runId of blocked) {
      expect((await getRun(runId))?.status).toBe('running');
    }

    // Cancellation while waiting ends `cancelled` and releases the session/runner.
    const cancelled = blocked[0];
    await requestRunCancel(cancelled, 'itest');
    await cancelRun(cancelled, 'itest', config);
    await waitForStatus(cancelled, 'cancelled');
    await waitForSessionRelease(cancelled);
    const cancelledEvents = await listEvents(cancelled, 0, 10_000);
    expect(cancelledEvents.filter((event) => event.type === 'run.completed')).toHaveLength(1);
    expect((cancelledEvents.at(-1)?.payload as { status?: string }).status).toBe('cancelled');

    // Clean up the rest: deny lets the scripted harness finish deterministically.
    for (const runId of blocked.slice(1)) await decide(runId, 'deny');
    for (const runId of blocked.slice(1)) await waitForStatus(runId, 'ok');
  }, 180_000);

  test('cancellation while waiting on a permission ends cancelled and kills the runner', async () => {
    const runId = `run_itest_cancel_${Date.now()}`;
    await startRun(runId);
    await waitForPermission(runId);
    expect(getSession(runId)).toBeDefined();

    await requestRunCancel(runId, 'user cancelled');
    await cancelRun(runId, 'user cancelled', config);
    await waitForStatus(runId, 'cancelled');

    const events = await listEvents(runId, 0, 10_000);
    const terminal = events.filter((event) => event.type === 'run.completed');
    expect(terminal).toHaveLength(1);
    expect((terminal[0].payload as { status?: string }).status).toBe('cancelled');
    // The ephemeral lease + adapter session are released by `killRunner`.
    await waitForSessionRelease(runId);
  }, 120_000);
});
