import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { closeClient, getSql } from '@factory/orchestration';
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
    // Autonomy state is shared across suites in the compose DB; leave the kill switch off
    // so a later smoke/E2E run is not blocked by this test's pause.
    const sql = getSql();
    await sql`delete from autonomy_state where factory in ('example', 'example-lights-off')`;
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
    // The compose database is shared: a passing attestation from an earlier benchmark run
    // would satisfy the gate. Remove it so the refusal is deterministic.
    await getSql()`
      delete from benchmark_attestations where factory = 'example-lights-off'
    `;
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
      details?: { factory?: string; definitionCommit?: string };
    };
    expect(refusedBody.code).toBe('benchmark_attestation_missing');
    expect(refusedBody.message).toContain('attestation');
    expect(refusedBody.details?.factory).toBe('example-lights-off');
    expect(refusedBody.details?.definitionCommit).toMatch(/^[0-9a-f]{40}$/);

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

  test('GET /autonomy returns the declared policy, live state and no invented timestamp', async () => {
    const sql = getSql();
    await sql`delete from autonomy_state where factory = 'example'`;

    const initial = await app.request('/autonomy?factory=example');
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as {
      autonomy: {
        factory: string;
        declared: {
          stages: Record<string, { gate: string }>;
          mergePolicy: string;
          fullyAutonomous: boolean;
          benchmarkGateRequired: boolean;
        };
        enabled: boolean;
        paused: boolean;
        updatedAt: string | null;
        everEnabled: boolean;
        reason: string | null;
        lastEvent: { type: string; at: string | null } | null;
      };
    };
    const read = initialBody.autonomy;
    expect(read.factory).toBe('example');
    expect(read.declared.stages.spec?.gate).toBe('human');
    expect(read.declared.mergePolicy).toBe('human');
    expect(read.declared.fullyAutonomous).toBe(false);
    expect(read.enabled).toBe(false);
    expect(read.paused).toBe(false);
    expect(read.everEnabled).toBe(false);
    expect(read.updatedAt).toBeNull();
    expect(read.reason).toContain('never');
    // A prior kill-switch action may have left an `autonomy.*` event on a work item; the
    // read model reports it as evidence. It never invents one.
    if (read.lastEvent) expect(read.lastEvent.type.startsWith('autonomy.')).toBe(true);

    const enabled = await postJson(app, '/autonomy', {
      factory: 'example',
      enabled: true,
      actor: 'ada',
      reason: 'itest: autonomy read',
    });
    expect(enabled.status).toBe(200);

    const after = await app.request('/autonomy?factory=example');
    const afterBody = (await after.json()) as {
      autonomy: {
        enabled: boolean;
        paused: boolean;
        actor: string | null;
        reason: string | null;
        updatedAt: string | null;
        everEnabled: boolean;
        benchmarkAttestation: { required: boolean; satisfied: boolean };
      };
    };
    expect(afterBody.autonomy.enabled).toBe(true);
    expect(afterBody.autonomy.paused).toBe(false);
    expect(afterBody.autonomy.actor).toBe('ada');
    expect(afterBody.autonomy.reason).toBe('itest: autonomy read');
    expect(afterBody.autonomy.updatedAt).toBeTruthy();
    expect(afterBody.autonomy.everEnabled).toBe(true);
    expect(afterBody.autonomy.benchmarkAttestation.required).toBe(false);
    expect(afterBody.autonomy.benchmarkAttestation.satisfied).toBe(true);
  }, 60_000);

  test('POST /work-items/:id/cancel records once, is idempotent and refuses a done item', async () => {
    const created = await postJson(app, '/work-items', {
      factory: 'example',
      title: 'itest: cancellable item',
      harness: 'fake',
    });
    const { workItem } = (await created.json()) as { workItem: { id: string } };

    const first = await postJson(app, `/work-items/${workItem.id}/cancel`, {
      actor: 'ada',
      reason: 'itest: cancel',
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      cancelled: boolean;
      alreadyCancelled: boolean;
      eventRecorded: boolean;
      cancelRequestedAt: string | null;
      workItem: { status: string; cancelActor: string | null; cancelReason: string | null };
    };
    expect(firstBody.eventRecorded).toBe(true);
    expect(firstBody.alreadyCancelled).toBe(false);
    expect(firstBody.cancelRequestedAt).toBeTruthy();
    expect(firstBody.workItem.cancelActor).toBe('ada');
    expect(firstBody.workItem.cancelReason).toBe('itest: cancel');

    const repeat = await postJson(app, `/work-items/${workItem.id}/cancel`, {
      actor: 'grace',
      reason: 'itest: repeat',
    });
    expect(repeat.status).toBe(200);
    const repeatBody = (await repeat.json()) as {
      alreadyRequested: boolean;
      eventRecorded: boolean;
      cancelRequestedAt: string | null;
    };
    expect(repeatBody.alreadyRequested).toBe(true);
    expect(repeatBody.eventRecorded).toBe(false);
    expect(repeatBody.cancelRequestedAt).toBe(firstBody.cancelRequestedAt);

    const detail = await app.request(`/work-items/${workItem.id}`);
    const detailBody = (await detail.json()) as {
      workItem: { cancelActor: string | null; cancelReason: string | null };
      events: { type: string }[];
    };
    expect(detailBody.workItem.cancelActor).toBe('ada');
    expect(detailBody.events.filter((event) => event.type === 'cancel.requested')).toHaveLength(1);

    // Terminal item: a done item is refused with invalid_state.
    const sql = getSql();
    await sql`update work_items set status = 'done' where id = ${workItem.id}`;
    const refused = await postJson(app, `/work-items/${workItem.id}/cancel`, {
      actor: 'ada',
      reason: 'itest: too late',
    });
    expect(refused.status).toBe(409);
    const refusedBody = (await refused.json()) as { code: string };
    expect(refusedBody.code).toBe('invalid_state');

    // An already-cancelled item returns the same state without a second event.
    await sql`update work_items set status = 'cancelled' where id = ${workItem.id}`;
    const already = await postJson(app, `/work-items/${workItem.id}/cancel`, {
      actor: 'ada',
      reason: 'itest: already cancelled',
    });
    expect(already.status).toBe(200);
    const alreadyBody = (await already.json()) as { alreadyCancelled: boolean; eventRecorded: boolean };
    expect(alreadyBody.alreadyCancelled).toBe(true);
    expect(alreadyBody.eventRecorded).toBe(false);
  }, 60_000);
});
