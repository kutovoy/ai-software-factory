import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import {
  getWorkItem,
  listWorkItemEvents,
  setWorkItemStatus,
  type WorkItemStatus,
} from '@factory/core';
import { FakeForge } from '@factory/forge';
import { clearSessions, closeClient, getForge, getSql, setForge } from '@factory/orchestration';
import { createWorker } from '@factory/orchestration/worker';
import { createApp } from '../src/app';
import { loadApiConfig, type ApiConfig } from '../src/config';
import { signGithubPayload } from '../src/webhooks';

/**
 * Phase 3b full chain (task 6.1): webhook → work item → loop → PR → merge queue → merged.
 *
 * Opt-in (needs Temporal + Postgres):
 *
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test apps/api/test/forge-chain.integration.test.ts
 *
 * The worker runs in-process on the fake harness + fake forge: no network, no credentials.
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');
/**
 * An isolated factory directory (a copy of `factories/example` under the git root) gives this
 * suite its own factory key, so the queue workflow id and the `merge_*` rows never collide
 * with the compose stack or an earlier run.
 */
const FACTORY = `chain-itest-${process.pid}`;
const FIXTURE_ROOT = join(REPO_ROOT, 'runs', '.chain-itest');
const SECRET = 'whsec_chain_itest';
const REPO = { owner: 'acme', name: 'api-service' };

let config: ApiConfig;
let app: Hono;
let worker: Awaited<ReturnType<typeof createWorker>>;
let running: Promise<void>;
const createdWorkItems: string[] = [];

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
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await app.request(path);
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

interface WorkItemDetail {
  workItem: { id: string; status: string; stage: string; prUrl: string | null; prNumber: number | null };
  pendingGate: { stage: string } | null;
  events: { type: string; payload: Record<string, unknown> }[];
}

const TERMINAL = new Set(['done', 'cancelled', 'escalated', 'blocked']);

/** Approves each human gate in order until the item reaches a terminal status. */
async function driveGates(workItemId: string): Promise<WorkItemDetail> {
  for (let step = 0; step < 20; step += 1) {
    const detail = await waitFor(
      `a gate or a terminal state on ${workItemId}`,
      async () => {
        const current = await getJson<WorkItemDetail>(`/work-items/${workItemId}`);
        if (TERMINAL.has(current.workItem.status)) return current;
        if (current.pendingGate) return current;
        return null;
      },
      60_000,
    );

    if (TERMINAL.has(detail.workItem.status)) return detail;

    const stage = detail.pendingGate!.stage;
    const response = await app.request(`/work-items/${workItemId}/gates/${stage}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', actor: 'itest', reason: `approve ${stage}` }),
    });
    expect(response.ok, `gate ${stage} failed: ${response.status}`).toBeTruthy();
  }
  throw new Error(`work item ${workItemId} did not reach a terminal state`);
}

suite('webhook → loop → merge queue', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL as string;
    process.env.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS as string;
    process.env.TEMPORAL_TASK_QUEUE = `factory-chain-itest-${process.pid}-${Date.now()}`;
    await mkdir(join(FIXTURE_ROOT, FACTORY), { recursive: true });
    await cp(join(REPO_ROOT, 'factories', 'example'), join(FIXTURE_ROOT, FACTORY), {
      recursive: true,
    });
    process.env.FACTORY_ROOT = FIXTURE_ROOT;
    process.env.REPO_ROOT = REPO_ROOT;
    process.env.RUNS_DIR = join(REPO_ROOT, 'runs');
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;

    await migrate(process.env.DATABASE_URL as string);

    // Remove integrations left by earlier runs of this suite: a stale factory key would
    // otherwise win the deterministic webhook tie-break and point at a deleted directory.
    const cleanup = new SQL(process.env.DATABASE_URL as string, { max: 1 });
    try {
      await cleanup`delete from integrations where factory like 'chain-itest-%'`;
      await cleanup`delete from merge_batches where factory like 'chain-itest-%'`;
      await cleanup`delete from merge_batch_items where factory like 'chain-itest-%'`;
    } finally {
      await cleanup.close();
    }

    const forge = new FakeForge();
    forge.seedRepo(REPO, { 'README.md': '# api-service\n' });
    setForge('fake', forge);

    config = loadApiConfig();
    app = createApp(config);

    // The compose stack may have a long-lived queue workflow for this factory (same
    // Temporal namespace). Terminate it so this run's enqueue is handled by *this* worker
    // and forge, not by the compose worker's in-memory forge.
    worker = await createWorker();
    running = worker.run();
    void running.catch(() => undefined);
  }, 120_000);

  afterAll(async () => {
    const sql = getSql();
    // Leave the factory on the Phase-3a behaviour for later runs.
    await sql`
      update integrations set config = jsonb_set(config, '{mergeQueue}', 'false'::jsonb)
      where factory = ${FACTORY} and provider = 'github'
    `.catch(() => undefined);
    for (const workItemId of createdWorkItems.splice(0)) {
      await setWorkItemStatus(sql, {
        workItemId,
        status: 'cancelled',
        actor: 'itest',
        reason: 'itest cleanup',
      }).catch(() => undefined);
    }
    await sql`delete from integrations where factory = ${FACTORY}`.catch(() => undefined);
    await sql`delete from merge_batches where factory = ${FACTORY}`.catch(() => undefined);
    await sql`delete from merge_batch_items where factory = ${FACTORY}`.catch(() => undefined);
    await rm(join(FIXTURE_ROOT, FACTORY), { recursive: true, force: true }).catch(() => undefined);
    await worker?.shutdown();
    await closeClient();
    clearSessions();
  }, 60_000);

  test('a signed issue is triaged, implemented, opened as a PR and merged by the queue', async () => {

    const configured = await app.request('/integrations/github', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        factory: FACTORY,
        secretRef: 'GITHUB_TOKEN',
        webhookSecretRef: 'GITHUB_WEBHOOK_SECRET',
        repos: [REPO],
        events: ['issues'],
        labels: ['factory-ready'],
        dryRun: true,
        mergeQueue: true,
        harness: 'fake',
        runner: 'fake',
      }),
    });
    expect(configured.status).toBe(200);

    const payload = JSON.stringify({
      action: 'labeled',
      repository: { full_name: 'acme/api-service' },
      sender: { login: 'ada', type: 'User' },
      label: { name: 'factory-ready' },
      issue: {
        number: 7777,
        title: 'Chain: retry the API client',
        html_url: 'https://github.com/acme/api-service/issues/7777',
        labels: [{ name: 'factory-ready' }],
      },
    });
    const deliveryId = `chain-${Date.now()}`;
    const delivered = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signGithubPayload(payload, SECRET),
      },
      body: payload,
    });
    expect(delivered.status, `webhook delivery failed: ${await delivered.clone().text()}`).toBe(202);
    const deliveredBody = (await delivered.json()) as { workItemId: string; status: string };
    expect(deliveredBody.status).toBe('accepted');
    createdWorkItems.push(deliveredBody.workItemId);

    const item = await getWorkItem(getSql(), deliveredBody.workItemId);
    expect(item?.source).toBe('forge');
    expect(item?.sourceRef).toMatchObject({ kind: 'issue', repo: 'acme/api-service' });

    const done = await driveGates(deliveredBody.workItemId);
    expect(done.workItem.status).toBe('done');
    expect(done.workItem.prUrl).toMatch(/^https:\/\/forge\.local\//);
    const prNumber = done.workItem.prNumber;
    expect(prNumber).toBeGreaterThan(0);

    // The ship stage enqueued instead of merging.
    const events = await listWorkItemEvents(getSql(), deliveredBody.workItemId);
    expect(events.some((event) => event.type === 'merge.queued')).toBe(true);

    // The queue merged the batch in the worker.
    const merged = await waitFor('the queued PR to be merged by the queue', async () => {
      const queue = await getJson<{
        batches: {
          status: string;
          items: { prNumber: number; status: string; workItemId: string | null }[];
          events: { type: string }[];
        }[];
      }>(`/factories/${FACTORY}/merge-queue`);
      const batch = queue.batches.find((entry) =>
        entry.items.some((candidate) => candidate.prNumber === prNumber),
      );
      return batch?.status === 'merged' ? batch : null;
    });

    const batchItem = merged.items.find((candidate) => candidate.prNumber === prNumber);
    expect(batchItem?.status).toBe('merged');
    expect(batchItem?.workItemId).toBe(deliveredBody.workItemId);
    expect(merged.events.map((event) => event.type)).toContain('merge.batch.merged');

    // The work item records the merge, and the forge PR is merged.
    const after = await getWorkItem(getSql(), deliveredBody.workItemId);
    expect(after?.status).toBe('done');
    const afterEvents = await listWorkItemEvents(getSql(), deliveredBody.workItemId);
    expect(afterEvents.some((event) => event.type === 'merge.merged')).toBe(true);

    const forge = getForge('fake') as FakeForge;
    const pulls = forge.listPullRequests(REPO);
    expect(pulls.find((pull) => pull.number === prNumber)?.state).toBe('merged');

    // The queue projection is what the console renders.
    const queue = await getJson<{
      batchSize: number;
      inFlight: unknown;
      queued: unknown[];
    }>(`/factories/${FACTORY}/merge-queue`);
    expect(queue.batchSize).toBe(config.mergeBatchSize);
    expect(queue.inFlight).toBeNull();
    expect(Array.isArray(queue.queued)).toBe(true);
  }, 300_000);

  test('the item is terminal and no gate is left pending', async () => {
    const workItemId = createdWorkItems[0];
    if (!workItemId) return;
    const detail = await getJson<WorkItemDetail>(`/work-items/${workItemId}`);
    const status = detail.workItem.status as WorkItemStatus;
    expect(['done', 'cancelled']).toContain(status);
    expect(detail.pendingGate).toBeNull();
  }, 30_000);
});
