import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { factoryIdOf, req } from './helpers';
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { closeClient } from '@factory/orchestration';
import { createApp } from '../src/app';
import { loadApiConfig, type ApiConfig } from '../src/config';

/**
 * Batch read-path integration tests (performance plan, Phases 1 and 2).
 *
 * Opt-in like the other integration suites:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test apps/api/test/inbox.integration.test.ts
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

suite('batch inbox and board projections', () => {
  beforeAll(async () => {
    process.env.FACTORY_ROOT = join(REPO_ROOT, 'factories');
    process.env.REPO_ROOT = REPO_ROOT;
    await migrate(process.env.DATABASE_URL as string);
    config = loadApiConfig();
    app = createApp(config);
  });

  afterAll(async () => {
    await closeClient();
  });

  test('GET /inbox returns three owner-scoped categories and counts', async () => {
    const response = await req(app, '/inbox?limit=5');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      gates: unknown[];
      permissions: unknown[];
      failures: unknown[];
      counts: { gates: number; permissions: number; failures: number };
    };
    expect(Array.isArray(body.gates)).toBe(true);
    expect(Array.isArray(body.permissions)).toBe(true);
    expect(Array.isArray(body.failures)).toBe(true);
    expect(body.gates.length).toBeLessThanOrEqual(5);
    expect(body.permissions.length).toBeLessThanOrEqual(5);
    expect(body.failures.length).toBeLessThanOrEqual(5);
    expect(body.counts.gates).toBeGreaterThanOrEqual(body.gates.length);
    expect(body.counts.permissions).toBeGreaterThanOrEqual(body.permissions.length);
    expect(body.counts.failures).toBeGreaterThanOrEqual(body.failures.length);
  });

  test('view=board resolves pending gates, run events, counts and a cursor in one call', async () => {
    const factoryId = await factoryIdOf(app, 'example');
    const response = await req(
      app,
      `/factories/${factoryId}/work-items?view=board&limit=5`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workItems: { id: string; pendingGate: unknown; events: unknown[] }[];
      counts: Record<string, number>;
      total: number;
      nextCursor: string | null;
    };
    expect(body.workItems.length).toBeLessThanOrEqual(5);
    expect(body.total).toBeGreaterThanOrEqual(body.workItems.length);
    expect(Object.keys(body.counts).length).toBeGreaterThan(0);
    for (const item of body.workItems) {
      expect(item.id).toMatch(/^wi_/);
      expect(Array.isArray(item.events)).toBe(true);
    }

    if (body.nextCursor) {
      const next = await req(
        app,
        `/factories/${factoryId}/work-items?view=board&limit=5&cursor=${encodeURIComponent(body.nextCursor)}`,
      );
      expect(next.status).toBe(200);
      const nextBody = (await next.json()) as { workItems: { id: string }[] };
      expect(nextBody.workItems[0]?.id).not.toBe(body.workItems[0]?.id);
    }
  });
});
