import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Worker } from '@temporalio/worker';
import {
  enqueueMergeItem,
  getMergeBatch,
  listMergeBatchItems,
  listMergeEvents,
  newWorkItemId,
  createWorkItem,
  type MergeBatchItemRecord,
} from '@factory/core';
import { FakeForge } from '@factory/forge';
import { closeClient } from '../src/client';
import { closeSql, getSql, setSql } from '../src/db';
import { loadConfig, type OrchestrationConfig } from '../src/config';
import { setForge } from '../src/activities/forge';
import { clearEphemeralLeases } from '../src/activities/runner';
import { clearSessions } from '../src/sessions';
import { createWorker } from '../src/worker';
import { ensureMergeQueueWorkflow, startMergeRevert } from '../src/merge-client';
import { mergeQueueWorkflowId } from '../src/types';

/**
 * Merge queue integration (spec `merge-queue`, ADR-022).
 *
 * Needs Temporal + Postgres, so it is opt-in (CI stays service-free):
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test packages/orchestration/test/merge-queue.integration.test.ts
 *
 * Everything runs on the fake forge in-process: no network, no credentials.
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');
/**
 * Each test owns a factory key. The queue is serialized per factory (one workflow id), and
 * the compose stack shares this database, so a dedicated key keeps runs independent and
 * avoids attaching to a queue run that is already draining.
 */
const FACTORY_PREFIX = `merge-itest-${process.pid}`;
const REPO = { owner: 'acme', name: 'api-service' };
const REPO_KEY = `${REPO.owner}/${REPO.name}`;

let config: OrchestrationConfig;
let worker: Worker;
let running: Promise<void>;
let forge: FakeForge;

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

/** Opens a PR on the fake forge and enqueues it (what the ship stage does). */
async function enqueuePr(
  factory: string,
  branch: string,
  files: Record<string, string>,
  options: { title?: string } = {},
): Promise<MergeBatchItemRecord> {
  await forge.createBranch({ repo: REPO, name: branch });
  await forge.commit({
    repo: REPO,
    branch,
    message: `change for ${branch}`,
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
  });
  const pull = await forge.openPullRequest({
    repo: REPO,
    head: branch,
    title: options.title ?? `PR ${branch}`,
  });

  const workItemId = newWorkItemId();
  await createWorkItem(getSql(), {
    id: workItemId,
    factory,
    type: 'task',
    source: 'manual',
    title: `Work item ${branch}`,
    stage: 'ship',
    definitionCommit: 'itest',
  });

  return await enqueueMergeItem(getSql(), {
    id: `mb_${workItemId.slice(3, 29)}`,
    factory,
    prNumber: pull.number,
    workItemId,
    head: branch,
  });
}

function queueInput(factory: string, overrides: Record<string, unknown> = {}) {
  return {
    factory,
    repo: REPO_KEY,
    batchSize: 2,
    checksTimeoutMs: 30_000,
    pollIntervalMs: 100,
    maxBatches: 3,
    actor: 'itest',
    ...overrides,
  };
}

suite('merge queue workflow', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL as string;
    process.env.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS as string;
    process.env.TEMPORAL_TASK_QUEUE = `factory-merge-itest-${process.pid}-${Date.now()}`;
    process.env.FACTORY_ROOT = join(REPO_ROOT, 'factories');
    process.env.REPO_ROOT = REPO_ROOT;
    process.env.RUNS_DIR = join(REPO_ROOT, 'runs');

    await migrate(process.env.DATABASE_URL as string);
    config = loadConfig();
    setSql(new SQL(config.databaseUrl, { max: 4 }));

    forge = new FakeForge();
    forge.seedRepo(REPO, { 'README.md': '# api-service\n' });
    setForge('fake', forge);

    worker = await createWorker(config);
    running = worker.run();
    void running.catch(() => undefined);
  }, 90_000);

  afterAll(async () => {
    // The database is shared with the compose stack; remove this run's isolated rows.
    await getSql()`
      delete from merge_batches where factory like ${`${FACTORY_PREFIX}%`}
    `.catch(() => undefined);
    await worker?.shutdown();
    await closeClient();
    await closeSql();
    clearSessions();
    clearEphemeralLeases();
  }, 30_000);

  test('a green batch merges as one unit and marks every PR merged', async () => {
    const factory = `${FACTORY_PREFIX}-green`;
    const first = await enqueuePr(factory, 'factory/green_1', { 'changes/one.txt': '1\n' });
    const second = await enqueuePr(factory, 'factory/green_2', { 'changes/two.txt': '2\n' });

    const started = await ensureMergeQueueWorkflow(queueInput(factory, { batchSize: 2 }), config);
    expect(started.workflowId).toBe(mergeQueueWorkflowId(factory));

    const batch = await waitFor('the batch to merge', async () => {
      const rows = await getSql()`
        select * from merge_batches where factory = ${factory} and status = 'merged'
        order by created_at desc limit 1
      `;
      return rows[0] ?? null;
    });

    const items = await listMergeBatchItems(getSql(), batch.id as string);
    expect(items.map((item) => item.prNumber).sort()).toEqual(
      [first.prNumber, second.prNumber].sort(),
    );
    expect(items.every((item) => item.status === 'merged')).toBe(true);

    const events = await listMergeEvents(getSql(), batch.id as string);
    const types = events.map((event) => event.type);
    expect(types).toContain('merge.batch.started');
    expect(types).toContain('merge.batch.merged');

    // The default branch advanced and both PRs are merged.
    const head = await forge.checkout({ repo: REPO });
    expect(head.commit).toBe(batch.merge_sha as string);
    expect(head.files['changes/one.txt']).toBe('1\n');
    expect(head.files['changes/two.txt']).toBe('2\n');
  }, 120_000);

  test('a red merged stack is bisected: clean prefix stays, offender needs_human, tail requeued', async () => {
    const factory = `${FACTORY_PREFIX}-bisect`;
    const clean = await enqueuePr(factory, 'factory/bisect_1', { 'changes/b1.txt': '1\n' });
    const offender = await enqueuePr(factory, 'factory/bisect_2', {
      'changes/b2.txt': '2\n',
      '.ci-fail': 'semantic conflict\n',
    });
    const tail = await enqueuePr(factory, 'factory/bisect_3', { 'changes/b3.txt': '3\n' });

    await ensureMergeQueueWorkflow(
      queueInput(factory, { batchSize: 3, checksTimeoutMs: 0, pollIntervalMs: 0 }),
      config,
    );

    const batch = await waitFor('the batch to be bisected', async () => {
      const rows = await getSql()`
        select id from merge_batches where factory = ${factory} and status = 'bisected'
        order by created_at desc limit 1
      `;
      const id = rows[0]?.id as string | undefined;
      return id ? await getMergeBatch(getSql(), id) : null;
    });

    const items = await listMergeBatchItems(getSql(), batch.id);
    const byPr = new Map(items.map((item) => [item.prNumber, item]));
    expect(byPr.get(clean.prNumber)?.status).toBe('merged');
    expect(byPr.get(offender.prNumber)?.status).toBe('needs_human');
    // The train keeps merging after the offender, so the tail lands too.
    expect(byPr.get(tail.prNumber)?.status).toBe('merged');

    const offenderItem = byPr.get(offender.prNumber);
    expect(offenderItem?.evidence).toMatchObject({ reason: 'red_stack' });
    expect(batch.evidence).toMatchObject({
      mergedPrs: [clean.prNumber, tail.prNumber],
      offenders: [offender.prNumber],
    });

    const events = await listMergeEvents(getSql(), batch.id);
    const types = events.map((event) => event.type);
    expect(types).toContain('merge.batch.red');
    expect(types).toContain('merge.reverted');
    expect(types).toContain('merge.item.needs_human');
    expect(types).toContain('merge.bisected');

    // The clean prefix and the requeued tail are on the default branch; the offender is not.
    const head = await forge.checkout({ repo: REPO });
    expect(head.files['changes/b1.txt']).toBe('1\n');
    expect(head.files['changes/b3.txt']).toBe('3\n');
    expect(head.files['changes/b2.txt']).toBeUndefined();
    expect(head.files['.ci-fail']).toBeUndefined();

    // The offender's work item is escalated to a human.
    const workItem = await getSql()`
      select * from work_items where id = ${offenderItem?.workItemId} limit 1
    `;
    expect(workItem[0]?.status).toBe('escalated');
  }, 120_000);

  test('a stack that never reports fails checks_timeout and nothing merges', async () => {
    const factory = `${FACTORY_PREFIX}-timeout`;
    const item = await enqueuePr(factory, 'factory/timeout_1', { 'changes/t.txt': 't\n' });
    const before = await forge.checkout({ repo: REPO });

    forge.setStackPending(true);
    try {
      await ensureMergeQueueWorkflow(
        queueInput(factory, { batchSize: 1, checksTimeoutMs: 0, pollIntervalMs: 0 }),
        config,
      );

      const batch = await waitFor('the batch to time out', async () => {
        const rows = await getSql()`
          select * from merge_batches
          where factory = ${factory} and status = 'reverted' and reason like '%did not complete%'
          order by created_at desc limit 1
        `;
        return rows[0] ?? null;
      });

      const items = await listMergeBatchItems(getSql(), batch.id as string);
      expect(items[0]?.prNumber).toBe(item.prNumber);
      expect(items[0]?.status).toBe('reverted');

      const events = await listMergeEvents(getSql(), batch.id as string);
      const types = events.map((event) => event.type);
      expect(types).toContain('merge.checks_timeout');
      expect(types).toContain('merge.reverted');

      const head = await forge.checkout({ repo: REPO });
      expect(head.files['changes/t.txt']).toBeUndefined();
      expect(head.commit).not.toBe(before.commit);
    } finally {
      forge.setStackPending(false);
    }
  }, 120_000);

  test('a manual revert restores the pre-batch tree and is audited', async () => {
    const factory = `${FACTORY_PREFIX}-revert`;
    const item = await enqueuePr(factory, 'factory/revert_1', { 'changes/r.txt': 'r\n' });

    await ensureMergeQueueWorkflow(queueInput(factory, { batchSize: 1 }), config);
    const batch = await waitFor('the batch to merge before the revert', async () => {
      const rows = await getSql()`
        select * from merge_batches where factory = ${factory} and status = 'merged'
        order by created_at desc limit 1
      `;
      return rows[0] ?? null;
    });
    expect((await forge.checkout({ repo: REPO })).files['changes/r.txt']).toBe('r\n');

    const reverted = await startMergeRevert(
      { factory, batchId: batch.id as string, actor: 'ada', reason: 'incident 42' },
      config,
    );
    expect(reverted.workflowId).toContain('merge-revert-');

    const after = await waitFor('the batch to be reverted', async () => {
      const current = await getMergeBatch(getSql(), batch.id as string);
      return current?.status === 'reverted' ? current : null;
    });
    expect(after.actor).toBe('ada');
    expect(after.reason).toBe('incident 42');

    const head = await forge.checkout({ repo: REPO });
    expect(head.files['changes/r.txt']).toBeUndefined();

    const events = await listMergeEvents(getSql(), batch.id as string);
    const revert = events.find((event) => event.type === 'merge.reverted' && event.subject === '');
    expect(revert?.payload).toMatchObject({ actor: 'ada', reason: 'incident 42', automatic: false });

    const rows = await getSql()`
      select * from merge_batch_items where pr_number = ${item.prNumber} and factory = ${factory} limit 1
    `;
    expect(rows[0]?.status).toBe('reverted');
  }, 120_000);
});
