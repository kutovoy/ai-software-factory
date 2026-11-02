import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { factoryIdOf, req } from './helpers';
import { SQL } from 'bun';
import { mkdtempSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import {
  clearEphemeralLeases,
  closeClient,
  getSql,
  insertRun,
  leaseRunner,
  probeMcpServer,
  type RunInput,
} from '@factory/orchestration';
import { getSecretUsage, listMcpServers, listSecrets, recordMcpTest } from '@factory/core';
import { createApp } from '../src/app';
import { loadApiConfig, type ApiConfig } from '../src/config';

/**
 * Secrets + MCP integration (change `add-secrets-and-mcp`, tasks 3.5 and 6.1).
 *
 * Opt-in like the other integration suites:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test apps/api/test/secrets.integration.test.ts
 *
 * Covers: register (metadata only) → presence status → a real lease recording the resolved
 * names → usage audit → delete guard → MCP registry sync, and a probe with a fake transport.
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');
const FACTORY_ROOT = join(REPO_ROOT, 'factories');
const SECRET = 'GITHUB_TOKEN'; // referenced by factories/example's MCP declaration
const RUN_ID = 'run_itest_secret_lease';

let config: ApiConfig;
let app: Hono;
let factoryId: string;

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

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await req(app, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

suite('secrets + MCP integration', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL as string;
    process.env.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS as string;
    process.env.FACTORY_ROOT = FACTORY_ROOT;
    process.env.REPO_ROOT = REPO_ROOT;
    process.env.RUNS_DIR = mkdtempSync(join(tmpdir(), 'itest-secret-runs-'));
    // A resolvable execution secret for the lease (fake value; CI stays credential-free).
    process.env[SECRET] = 'ghp_itest_value_never_recorded';

    await migrate(process.env.DATABASE_URL as string);
    config = loadApiConfig();
    app = createApp(config);
    factoryId = await factoryIdOf(app, 'example');

    const sql = getSql();
    await sql`delete from secrets where name in (${SECRET}, 'ITEST_MISSING_TOKEN')`;
    await sql`delete from secret_usage where secret_name in (${SECRET}, 'ITEST_MISSING_TOKEN')`;
    await sql`delete from run_secrets where run_id = ${RUN_ID}`;
    await sql`delete from runs where id = ${RUN_ID}`;
    await sql`delete from mcp_tests where factory = 'example' and server = 'github'`;
    await sql`delete from mcp_bindings where factory = 'example'`;
    await sql`delete from mcp_servers where factory = 'example'`;
  }, 60_000);

  afterAll(async () => {
    const sql = getSql();
    await sql`delete from secrets where name in (${SECRET}, 'ITEST_MISSING_TOKEN')`;
    await sql`delete from secret_usage where secret_name in (${SECRET}, 'ITEST_MISSING_TOKEN')`;
    await sql`delete from run_secrets where run_id = ${RUN_ID}`;
    await sql`delete from runs where id = ${RUN_ID}`;
    await sql`delete from mcp_tests where factory = 'example'`;
    await sql`delete from mcp_bindings where factory = 'example'`;
    await sql`delete from mcp_servers where factory = 'example'`;
    await closeClient();
  }, 30_000);

  test('register reports presence and never returns a value', async () => {
    const created = await post('/secrets', {
      name: SECRET,
      provider: 'env',
      scope: 'factory',
      description: 'itest secret',
    });
    expect(created.status).toBe(201);
    expect(created.body.secret.status).toBe('resolved');
    expect(JSON.stringify(created.body)).not.toContain('ghp_itest_value_never_recorded');
    expect(Object.keys(created.body.secret).sort()).toEqual(
      [
        'createdAt',
        'description',
        'lastRotatedAt',
        'lastRunId',
        'lastUsedAt',
        'name',
        'provider',
        'scope',
        'status',
        'updatedAt',
        'useCount',
      ].sort(),
    );

    const unresolved = await post('/secrets', { name: 'ITEST_MISSING_TOKEN' });
    expect(unresolved.body.secret.status).toBe('unresolved');

    const list = await req(app, '/secrets');
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { secrets: Array<{ name: string; status: string }> };
    expect(listed.secrets.find((secret) => secret.name === SECRET)?.status).toBe('resolved');
    expect(listed.secrets.find((secret) => secret.name === 'ITEST_MISSING_TOKEN')?.status).toBe(
      'unresolved',
    );
  });

  test('a lease records the resolved names and the usage audit follows', async () => {
    const sql = getSql();
    const input: RunInput = {
      runId: RUN_ID,
      factory: 'example',
      factoryRoot: join(FACTORY_ROOT, 'example'),
      definitionCommit: 'a'.repeat(40),
      definitionDirty: false,
      harness: 'fake',
      agent: 'implement',
      runner: 'fake',
      prompt: { text: 'itest: secret lease' },
      kind: 'run',
      title: 'itest secret lease',
      proxyModels: [],
    };

    await insertRun({
      runId: RUN_ID,
      factory: 'example',
      definitionCommit: input.definitionCommit,
      definitionDirty: false,
      harness: 'fake',
      model: null,
      runner: 'fake',
      kind: 'run',
      title: input.title ?? null,
      input,
      workflowId: `run-${RUN_ID}`,
    });

    const lease = await leaseRunner({ input });
    expect(lease.ephemeral).toBe(true);

    const recorded = (await sql`
      select secret_name, resolved from run_secrets where run_id = ${RUN_ID} order by secret_name
    `) as { secret_name: string; resolved: boolean }[];
    const names = recorded.map((row) => row.secret_name);
    expect(names).toContain(SECRET);
    expect(names).toContain('OPENCODE_API_KEY');
    // Values never land in the read model.
    const serialised = JSON.stringify(recorded);
    expect(serialised).not.toContain('ghp_itest_value_never_recorded');

    const usage = await getSecretUsage(sql, SECRET);
    expect(usage.usage?.useCount).toBeGreaterThanOrEqual(1);
    expect(usage.usage?.lastRunId).toBe(RUN_ID);

    // A retried lease is idempotent: no inflated count.
    clearEphemeralLeases();
    await leaseRunner({ input });
    const again = await getSecretUsage(sql, SECRET);
    expect(again.usage?.useCount).toBe(usage.usage?.useCount as number);
  }, 60_000);

  test('GET /secrets/:name/usage returns the run and the referencing resources', async () => {
    const response = await req(app, `/secrets/${SECRET}/usage`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      name: string;
      registered: boolean;
      useCount: number;
      lastRunId: string | null;
      runs: { runId: string; resolved: boolean }[];
      references: { kind: string }[];
    };
    expect(body.registered).toBe(true);
    expect(body.useCount).toBeGreaterThanOrEqual(1);
    expect(body.runs.some((run) => run.runId === RUN_ID && run.resolved)).toBe(true);
    expect(body.references.length).toBeGreaterThan(0);
  });

  test('delete is refused while a definition references the name', async () => {
    const response = await req(app, `/secrets/${SECRET}`, { method: 'DELETE' });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('secret_in_use');
  });

  test('MCP sync registers declared servers and bindings', async () => {
    const sync = await post(`/factories/${factoryId}/mcp`, {});
    expect(sync.status).toBe(200);
    const projection = sync.body as {
      servers: Array<{ name: string; transport: string; status: string; agents: string[] }>;
      agents: Array<{ agent: string; servers: string[]; allow: string[]; deny: string[] }>;
    };

    const github = projection.servers.find((server) => server.name === 'github');
    expect(github).toMatchObject({ transport: 'stdio' });
    expect(github?.agents).toContain('implement');

    const implement = projection.agents.find((agent) => agent.agent === 'implement');
    expect(implement?.servers).toEqual(['github']);
    expect(implement?.allow).toEqual(['github*']);
    const review = projection.agents.find((agent) => agent.agent === 'review');
    expect(review?.deny).toEqual(['github*']);

    const stored = await listMcpServers(getSql(), 'example');
    expect(stored.find((server) => server.name === 'github')?.env).toEqual({
      GITHUB_TOKEN: 'GITHUB_TOKEN',
    });

    // GET is the same projection.
    const fetched = await req(app, `/factories/${factoryId}/mcp`);
    expect(fetched.status).toBe(200);
    expect(((await fetched.json()) as { servers: unknown[] }).servers.length).toBeGreaterThan(0);
  });

  test('the probe runs with a fake transport and is recorded by name only', async () => {
    const sql = getSql();

    // Fake transport: no real MCP server, no network.
    const failed = await probeMcpServer(
      {
        name: 'github',
        transport: 'stdio',
        command: 'github-mcp',
        args: ['--stdio'],
        env: { GITHUB_TOKEN: 'GITHUB_TOKEN' },
      },
      {
        exec: async () => ({ code: 127, stdout: '', stderr: 'github-mcp: not found' }),
        resolveSecret: (name) => (name === 'GITHUB_TOKEN' ? 'ghp_itest_value_never_recorded' : undefined),
      },
    );
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('not found');
    expect(failed.executor).toBe('worker');
    expect(JSON.stringify(failed)).not.toContain('ghp_itest_value_never_recorded');

    const healthy = await probeMcpServer(
      { name: 'docs', transport: 'http', url: 'https://mcp.example.com/mcp' },
      {
        fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      },
    );
    expect(healthy.ok).toBe(true);
    expect(healthy.transport).toBe('http');

    const recorded = await recordMcpTest(sql, {
      factory: 'example',
      server: 'github',
      transport: failed.transport,
      ok: failed.ok,
      latencyMs: failed.latencyMs,
      error: failed.error,
      runnerId: 'mcp-example-github',
    });
    expect(recorded.ok).toBe(false);
    const servers = await listMcpServers(sql, 'example');
    expect(servers.find((server) => server.name === 'github')?.status).toBe('unhealthy');
  }, 60_000);

  test('a registered name that is not referenced can be deleted', async () => {
    const response = await req(app, '/secrets/ITEST_MISSING_TOKEN', { method: 'DELETE' });
    expect(response.status).toBe(200);
    const registered = await listSecrets(getSql(), { resolves: () => false });
    expect(registered.find((entry) => entry.secret.name === 'ITEST_MISSING_TOKEN')).toBeUndefined();
  });
});
