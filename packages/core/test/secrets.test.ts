import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SecretRegistryError,
  deleteSecret,
  getSecret,
  getSecretUsage,
  latestMcpTest,
  listMcpBindings,
  listMcpServers,
  listSecrets,
  recordMcpTest,
  recordRunSecrets,
  registerSecret,
  replaceMcpRegistry,
  rotateSecret,
} from '../src/index';

/**
 * Secret registry + MCP index (change `add-secrets-and-mcp`, spec `secrets`).
 *
 * The registry is name-only: a `value` field is refused, presence is reported without the
 * value, and a referenced name cannot be deleted. DB-free cases run in CI; the persistence
 * cases are opt-in:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory RUN_INTEGRATION=1 \
 *   bun test packages/core/test/secrets.test.ts
 */

const enabled = process.env.RUN_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;

const MIGRATIONS = join(import.meta.dir, '..', 'migrations');

/** A SQL stub that fails loudly: the rejection must happen before any query. */
const untouchedSql = (() => {
  throw new Error('database was touched');
}) as unknown as SQL;

describe('name-only registry (no database)', () => {
  test('register rejects a value with secret_value_rejected before touching the database', async () => {
    let error: unknown;
    try {
      await registerSecret(untouchedSql, { name: 'GITHUB_TOKEN', value: 'ghp_abcdefghijklmnop' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SecretRegistryError);
    expect((error as SecretRegistryError).code).toBe('secret_value_rejected');
  });

  test('rotate rejects a value too', async () => {
    let error: unknown;
    try {
      await rotateSecret(untouchedSql, { name: 'GITHUB_TOKEN', value: 'sk-abcdefghijklmnop' });
    } catch (caught) {
      error = caught;
    }
    expect((error as SecretRegistryError).code).toBe('secret_value_rejected');
  });

  test('delete refuses an in-use secret with secret_in_use naming the resources', async () => {
    let error: unknown;
    try {
      await deleteSecret(untouchedSql, 'GITHUB_TOKEN', {
        references: [
          {
            name: 'GITHUB_TOKEN',
            kind: 'mcp',
            resource: 'mcp:github',
            pointer: '/mcp/servers/github/env/GITHUB_TOKEN',
          },
        ],
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as SecretRegistryError).code).toBe('secret_in_use');
    expect((error as SecretRegistryError).details).toMatchObject({
      references: [{ resource: 'mcp:github' }],
    });
  });
});

/* ------------------------------------------------------------------ persistence */

const FACTORY = 'itest-secrets';

let sql: SQL;

async function migrate(databaseUrl: string): Promise<void> {
  const client = new SQL(databaseUrl, { max: 1 });
  try {
    await client`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = new Set(
      ((await client`select name from schema_migrations`) as { name: string }[]).map((row) => row.name),
    );
    const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.unsafe(await readFile(join(MIGRATIONS, file), 'utf8'));
      await client`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
  } finally {
    await client.close();
  }
}

suite('secret registry persistence', () => {
  beforeAll(async () => {
    await migrate(process.env.DATABASE_URL as string);
    sql = new SQL(process.env.DATABASE_URL as string, { max: 2 });
    await sql`delete from secrets where name like 'ITEST_%'`;
    await sql`delete from secret_usage where secret_name like 'ITEST_%'`;
    await sql`delete from run_secrets where run_id like 'run_itest_%'`;
    await sql`delete from mcp_tests where factory = ${FACTORY}`;
    await sql`delete from mcp_bindings where factory = ${FACTORY}`;
    await sql`delete from mcp_servers where factory = ${FACTORY}`;
  }, 60_000);

  afterAll(async () => {
    await sql`delete from secrets where name like 'ITEST_%'`;
    await sql`delete from secret_usage where secret_name like 'ITEST_%'`;
    await sql`delete from run_secrets where run_id like 'run_itest_%'`;
    await sql`delete from mcp_tests where factory = ${FACTORY}`;
    await sql`delete from mcp_bindings where factory = ${FACTORY}`;
    await sql`delete from mcp_servers where factory = ${FACTORY}`;
    await sql.close();
  }, 30_000);

  test('register stores metadata only and reports presence without the value', async () => {
    const registered = await registerSecret(
      sql,
      { name: 'ITEST_TOKEN', provider: 'env', scope: 'factory', description: 'itest' },
      { resolves: () => true },
    );
    expect(registered.status).toBe('resolved');
    expect(registered.secret).toMatchObject({
      name: 'ITEST_TOKEN',
      provider: 'env',
      scope: 'factory',
      description: 'itest',
    });
    // No value field exists in the projection, not even masked.
    expect(Object.keys(registered.secret)).toEqual([
      'name',
      'provider',
      'scope',
      'description',
      'lastRotatedAt',
      'createdAt',
      'updatedAt',
    ]);

    const unresolved = await registerSecret(
      sql,
      { name: 'ITEST_MISSING' },
      { resolves: () => false },
    );
    expect(unresolved.status).toBe('unresolved');

    const listed = await listSecrets(sql, { resolves: (name) => name === 'ITEST_TOKEN' });
    const token = listed.find((entry) => entry.secret.name === 'ITEST_TOKEN');
    expect(token?.status).toBe('resolved');
    expect(listed.find((entry) => entry.secret.name === 'ITEST_MISSING')?.status).toBe(
      'unresolved',
    );
  });

  test('rotate bumps lastRotatedAt and keeps the metadata name-only', async () => {
    const before = await getSecret(sql, 'ITEST_TOKEN', { resolves: () => true });
    const rotated = await rotateSecret(
      sql,
      { name: 'ITEST_TOKEN', description: 'rotated by itest' },
      { resolves: () => true },
    );
    expect(rotated.secret.lastRotatedAt).toBeTruthy();
    expect(rotated.secret.description).toBe('rotated by itest');
    if (before?.secret.lastRotatedAt) {
      expect(Date.parse(rotated.secret.lastRotatedAt as string)).toBeGreaterThanOrEqual(
        Date.parse(before.secret.lastRotatedAt),
      );
    }

    let error: unknown;
    try {
      await rotateSecret(sql, { name: 'ITEST_NEVER_REGISTERED' });
    } catch (caught) {
      error = caught;
    }
    expect((error as SecretRegistryError).code).toBe('secret_not_found');
  });

  test('usage is recorded per run by name only and is idempotent', async () => {
    const runId = 'run_itest_usage_1';
    await recordRunSecrets(sql, {
      runId,
      secrets: [
        { name: 'ITEST_TOKEN', resolved: true },
        { name: 'ITEST_MISSING', resolved: false },
      ],
    });
    // A retried lease must not inflate the count.
    await recordRunSecrets(sql, {
      runId,
      secrets: [
        { name: 'ITEST_TOKEN', resolved: true },
        { name: 'ITEST_MISSING', resolved: false },
      ],
    });

    const usage = await getSecretUsage(sql, 'ITEST_TOKEN');
    expect(usage.usage?.useCount).toBe(1);
    expect(usage.usage?.lastRunId).toBe(runId);
    expect(usage.runs).toEqual([{ runId, resolved: true, recordedAt: expect.any(String) }]);

    // The unresolved name is audited but does not count as a use.
    const missing = await getSecretUsage(sql, 'ITEST_MISSING');
    expect(missing.usage).toBeNull();
    expect(missing.runs[0]?.resolved).toBe(false);
  });

  test('delete refuses an in-use secret and removes an unused one', async () => {
    let error: unknown;
    try {
      await deleteSecret(sql, 'ITEST_TOKEN', {
        references: [
          {
            name: 'ITEST_TOKEN',
            kind: 'agent',
            resource: 'implement',
            pointer: '/secrets/0',
          },
        ],
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as SecretRegistryError).code).toBe('secret_in_use');
    expect(await getSecret(sql, 'ITEST_TOKEN')).not.toBeNull();

    expect(await deleteSecret(sql, 'ITEST_MISSING')).toBe(true);
    expect(await getSecret(sql, 'ITEST_MISSING')).toBeNull();
    expect(await deleteSecret(sql, 'ITEST_MISSING')).toBe(false);
  });

  test('MCP servers/bindings upsert and a probe result flips the status', async () => {
    await replaceMcpRegistry(sql, {
      factory: FACTORY,
      servers: [
        {
          factory: FACTORY,
          name: 'github',
          transport: 'stdio',
          command: 'github-mcp',
          args: ['--stdio'],
          env: { GITHUB_TOKEN: 'ITEST_TOKEN' },
        },
      ],
      bindings: [
        { factory: FACTORY, agent: 'implement', server: 'github', toolsAllow: ['github*'], toolsDeny: [] },
      ],
    });

    const servers = await listMcpServers(sql, FACTORY);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: 'github',
      transport: 'stdio',
      command: 'github-mcp',
      args: ['--stdio'],
      env: { GITHUB_TOKEN: 'ITEST_TOKEN' },
      status: 'untested',
    });

    const bindings = await listMcpBindings(sql, FACTORY);
    expect(bindings).toEqual([
      {
        factory: FACTORY,
        agent: 'implement',
        server: 'github',
        toolsAllow: ['github*'],
        toolsDeny: [],
        updatedAt: expect.any(String),
      },
    ]);

    const failed = await recordMcpTest(sql, {
      factory: FACTORY,
      server: 'github',
      transport: 'stdio',
      ok: false,
      latencyMs: 12,
      error: 'github-mcp: not found',
      runnerId: 'factory-mcp-itest',
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe('github-mcp: not found');
    expect((await listMcpServers(sql, FACTORY))[0]?.status).toBe('unhealthy');

    const healthy = await recordMcpTest(sql, {
      factory: FACTORY,
      server: 'github',
      transport: 'stdio',
      ok: true,
      latencyMs: 5,
    });
    expect(healthy.latencyMs).toBe(5);
    expect((await listMcpServers(sql, FACTORY))[0]?.status).toBe('healthy');
    expect((await latestMcpTest(sql, FACTORY, 'github'))?.id).toBe(healthy.id);
  });
});
