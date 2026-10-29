import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { closeClient } from '@factory/orchestration';
import { createApp } from '../src/app';
import { loadApiConfig, type ApiConfig } from '../src/config';

/**
 * API integration tests for work items, gate decisions and autonomy.
 *
 * Opt-in like the orchestration integration tests:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test apps/api/test/work-items.integration.test.ts
 *
 * The API starts real workflows on a dedicated task queue with no worker, so the routes
 * are exercised end to end without racing the compose worker.
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');

let config: ApiConfig;
let app: Hono;
let fixturesApp: Hono;

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

const JSON_HEADERS = { 'content-type': 'application/json' };

async function postJson(target: Hono, path: string, body: unknown): Promise<Response> {
  return await target.request(path, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

suite('work item API', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL as string;
    process.env.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS as string;
    process.env.TEMPORAL_TASK_QUEUE = `factory-api-itest-${process.pid}-${Date.now()}`;
    process.env.FACTORY_ROOT = join(REPO_ROOT, 'factories');
    process.env.REPO_ROOT = REPO_ROOT;

    await migrate(process.env.DATABASE_URL as string);
    config = loadApiConfig();
    app = createApp(config);
    fixturesApp = createApp({
      ...config,
      factoryRoot: join(REPO_ROOT, 'apps', 'api', 'test', 'fixtures'),
    });
  }, 60_000);

  afterAll(async () => {
    await closeClient();
  }, 30_000);

  test('POST /work-items creates a manual item, compiles the graph and starts the workflow', async () => {
    const response = await postJson(app, '/work-items', {
      factory: 'example',
      title: 'Add retry to the API client',
      source: 'manual',
      sourceRef: { kind: 'issue', id: '123', url: 'https://forge.local/acme/api-service/issues/123' },
      harness: 'fake',
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      workItem: { id: string; stage: string; status: string; factory: string; sourceRef: unknown };
      workflow: { workflowId: string } | null;
    };
    expect(body.workItem.id).toMatch(/^wi_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.workItem.factory).toBe('example');
    expect(body.workItem.stage).toBe('triage');
    expect(body.workItem.status).toBe('active');
    expect(body.workItem.sourceRef).toMatchObject({ kind: 'issue', id: '123' });
    expect(body.workflow?.workflowId).toBe(`factory-${body.workItem.id}`);

    const list = await app.request('/work-items?factory=example&stage=triage&status=active');
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { workItems: Array<{ id: string }> };
    expect(listed.workItems.some((item) => item.id === body.workItem.id)).toBe(true);

    const detail = await app.request(`/work-items/${body.workItem.id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      workItem: { id: string };
      events: Array<{ type: string }>;
      gates: unknown[];
    };
    expect(detailBody.workItem.id).toBe(body.workItem.id);
    expect(detailBody.events.map((event) => event.type)).toContain('work_item.created');
    expect(detailBody.gates).toEqual([]);
  }, 60_000);

  test('GET /work-items/:id returns 404 for an unknown item', async () => {
    const response = await app.request('/work-items/wi_00000000000000000000000000');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('work_item_not_found');
  });

  test('POST /work-items/:id/gates/:stage returns 404 when no gate is pending', async () => {
    const created = await postJson(app, '/work-items', {
      factory: 'example',
      title: 'Add retry to the API client',
      harness: 'fake',
    });
    const { workItem } = (await created.json()) as { workItem: { id: string } };

    const response = await postJson(app, `/work-items/${workItem.id}/gates/spec`, {
      decision: 'approve',
      actor: 'ada',
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('gate_not_found');

    const unknownStage = await postJson(app, `/work-items/${workItem.id}/gates/deploy`, {
      decision: 'approve',
      actor: 'ada',
    });
    expect(unknownStage.status).toBe(400);
  }, 60_000);

  test('POST /autonomy refuses lights-off without a benchmark gate override', async () => {
    const refused = await postJson(app, '/autonomy', {
      factory: 'example-lights-off',
      enabled: true,
      actor: 'ada',
      reason: 'run lights-off',
    });
    expect(refused.status).toBe(409);
    const refusedBody = (await refused.json()) as {
      code: string;
      message: string;
      details?: { benchmarkGateRequired?: boolean };
    };
    expect(refusedBody.code).toBe('autonomy_refused');
    expect(refusedBody.message).toContain('benchmark');
    expect(refusedBody.details?.benchmarkGateRequired).toBe(true);

    const allowed = await postJson(app, '/autonomy', {
      factory: 'example-lights-off',
      enabled: true,
      actor: 'ada',
      reason: 'run lights-off',
      override: { actor: 'grace', reason: 'accepted risk until Phase 4 benchmarks exist' },
    });
    expect(allowed.status).toBe(200);
    const allowedBody = (await allowed.json()) as {
      autonomy: {
        enabled: boolean;
        paused: boolean;
        benchmarkGateRequired: boolean;
        benchmarkGateSatisfied: boolean;
        overrideActor: string | null;
      };
    };
    expect(allowedBody.autonomy.enabled).toBe(true);
    expect(allowedBody.autonomy.paused).toBe(false);
    expect(allowedBody.autonomy.benchmarkGateRequired).toBe(true);
    expect(allowedBody.autonomy.benchmarkGateSatisfied).toBe(true);
    expect(allowedBody.autonomy.overrideActor).toBe('grace');
  }, 60_000);

  test('POST /autonomy pauses autonomy (kill switch) with an actor and reason', async () => {
    const response = await postJson(app, '/autonomy', {
      factory: 'example',
      enabled: false,
      actor: 'grace',
      reason: 'incident 42',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      autonomy: { enabled: boolean; paused: boolean; actor: string; reason: string };
    };
    expect(body.autonomy.enabled).toBe(false);
    expect(body.autonomy.paused).toBe(true);
    expect(body.autonomy.actor).toBe('grace');
    expect(body.autonomy.reason).toBe('incident 42');
  }, 60_000);

  test('POST /work-items rejects a cyclic stage graph with invalid_stage_graph', async () => {
    const response = await postJson(fixturesApp, '/work-items', {
      factory: 'cycle-factory',
      title: 'anything',
      harness: 'fake',
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('invalid_stage_graph');
    expect(body.message).toContain('cycle');
  }, 30_000);

  test('POST /work-items rejects a dispatch the foreman is not allowed to make', async () => {
    const response = await postJson(fixturesApp, '/work-items', {
      factory: 'spawn-denied-factory',
      title: 'anything',
      harness: 'fake',
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; details?: { agent?: string } };
    expect(body.code).toBe('spawn_not_allowed');
    expect(body.details?.agent).toBe('spec');
  }, 30_000);
});
