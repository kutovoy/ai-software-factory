import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { closeClient, getSql } from '@factory/orchestration';
import { createApp } from '../src/app';
import { loadApiConfig, type ApiConfig } from '../src/config';
import { factoryIdOf, req } from './helpers';

/**
 * API integration tests for retry-as-new-run (change `add-run-retry`).
 *
 * Opt-in like the other integration suites:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test apps/api/test/runs.integration.test.ts
 *
 * The API starts real workflows on a dedicated task queue with no worker, so retry is
 * exercised through the route and read model without racing the compose worker.
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
let exampleId: string;
const createdRunIds: string[] = [];

async function migrate(databaseUrl: string): Promise<void> {
  const sql = new SQL(databaseUrl, { max: 1 });
  try {
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

async function postJson(path: string, body: unknown): Promise<Response> {
  return await req(app, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function insertRun(options: {
  status: 'error' | 'ok' | 'running' | 'cancelled';
  kind?: 'chat' | 'run';
  error?: string | null;
}): Promise<string> {
  const id = `run_retry_itest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sql = getSql();
  await sql`
    insert into runs (
      id, factory, factory_id, definition_commit, definition_dirty, harness, model, runner, kind,
      title, input, status, workflow_id, error, ended_at
    ) values (
      ${id}, 'example', ${exampleId}, 'itest', false, 'fake', 'fake/fake-model', 'fake', ${options.kind ?? 'chat'},
      'itest retry', ${JSON.stringify({
        prompt: { text: 'retry this run' },
        title: 'itest retry',
        harness: 'fake',
        model: 'fake/fake-model',
        runner: 'fake',
        kind: options.kind ?? 'chat',
      })}::jsonb, ${options.status}, ${`wf_${id}`}, ${options.error ?? null},
      ${options.status === 'error' || options.status === 'cancelled' || options.status === 'ok' ? new Date() : null}
    )
  `;
  createdRunIds.push(id);
  return id;
}

suite('chat run retry API', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL as string;
    process.env.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS as string;
    process.env.TEMPORAL_TASK_QUEUE = `factory-api-retry-itest-${process.pid}-${Date.now()}`;
    process.env.FACTORY_ROOT = join(REPO_ROOT, 'factories');
    process.env.REPO_ROOT = REPO_ROOT;

    await migrate(process.env.DATABASE_URL as string);
    config = loadApiConfig();
    app = createApp(config);
    exampleId = await factoryIdOf(app, 'example');
  }, 60_000);

  afterAll(async () => {
    const sql = getSql();
    for (const id of createdRunIds) {
      await sql`delete from runs where id = ${id}`;
    }
    await closeClient();
  }, 30_000);

  test('an error chat run starts a new run with lineage and leaves the original unchanged', async () => {
    const originalId = await insertRun({ status: 'error', error: 'runner_unavailable: no sandbox' });

    const response = await postJson(`/factories/${exampleId}/runs/${originalId}/retry`, {});
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      run: { id: string; status: string };
      retryOf: string;
      deduped: boolean;
    };

    expect(body.retryOf).toBe(originalId);
    expect(body.deduped).toBe(false);
    expect(body.run.id).not.toBe(originalId);
    expect(body.run.status).toBe('pending');
    createdRunIds.push(body.run.id);

    const child = await req(app, `/factories/${exampleId}/runs/${body.run.id}`);
    expect(child.status).toBe(200);
    const childBody = (await child.json()) as {
      run: { id: string; input: { retryOf?: string } };
      retryOf: string | null;
      retriedBy: string | null;
    };
    expect(childBody.run.input.retryOf).toBe(originalId);
    expect(childBody.retryOf).toBe(originalId);

    const original = await req(app, `/factories/${exampleId}/runs/${originalId}`);
    expect(original.status).toBe(200);
    const originalBody = (await original.json()) as {
      run: { status: string; error: string | null };
      retryOf: string | null;
      retriedBy: string | null;
    };
    expect(originalBody.run.status).toBe('error');
    expect(originalBody.run.error).toBe('runner_unavailable: no sandbox');
    expect(originalBody.retryOf).toBeNull();
    expect(originalBody.retriedBy).toBe(body.run.id);
  }, 60_000);

  test('a double retry inside the dedupe window returns the same child', async () => {
    const originalId = await insertRun({ status: 'cancelled' });

    const first = await postJson(`/factories/${exampleId}/runs/${originalId}/retry`, {});
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { run: { id: string }; deduped: boolean };
    createdRunIds.push(firstBody.run.id);

    const second = await postJson(`/factories/${exampleId}/runs/${originalId}/retry`, {});
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { run: { id: string }; deduped: boolean };
    expect(secondBody.deduped).toBe(true);
    expect(secondBody.run.id).toBe(firstBody.run.id);
  }, 60_000);

  test('running, ok, and factory stage runs are refused with run_not_retryable', async () => {
    for (const [label, status, kind] of [
      ['running chat', 'running', 'chat'],
      ['ok chat', 'ok', 'chat'],
      ['stage run', 'error', 'run'],
    ] as const) {
      const id = await insertRun({ status, kind });
      const response = await postJson(`/factories/${exampleId}/runs/${id}/retry`, {});
      expect(response.status, label).toBe(409);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe('run_not_retryable');
      expect(body.message.length).toBeGreaterThan(0);
    }
  }, 60_000);
});
