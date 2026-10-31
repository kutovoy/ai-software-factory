import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { listMcpServers, recordMcpTest } from '../src/index';

/**
 * MCP probe status (bugfix): a probe may target a server that is declared in git but has
 * not been synced into the `mcp_servers` projection. Before the fix the status update
 * matched zero rows and the server stayed invisible/untested.
 *
 * Opt-in (needs Postgres with migrations applied):
 *
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory_test \
 *   RUN_INTEGRATION=1 bun test packages/core/test/mcp-status.integration.test.ts
 */

const enabled = process.env.RUN_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;

const FACTORY = 'itest-mcp-status';
const SERVER = 'ghost-server';

let sql: SQL;

suite('MCP probe status', () => {
  beforeAll(async () => {
    sql = new SQL(process.env.DATABASE_URL as string, { max: 1 });
    await sql`delete from mcp_tests where factory = ${FACTORY}`;
    await sql`delete from mcp_servers where factory = ${FACTORY}`;
  });

  afterAll(async () => {
    await sql`delete from mcp_tests where factory = ${FACTORY}`;
    await sql`delete from mcp_servers where factory = ${FACTORY}`;
    await sql.close();
  });

  test('a probe on an unprojected server still flips its status', async () => {
    await recordMcpTest(sql, {
      factory: FACTORY,
      server: SERVER,
      transport: 'stdio',
      ok: true,
      latencyMs: 12,
    });

    const servers = await listMcpServers(sql, FACTORY);
    const ghost = servers.find((server) => server.name === SERVER);
    expect(ghost).toBeDefined();
    expect(ghost?.status).toBe('healthy');
    expect(ghost?.transport).toBe('stdio');
  });

  test('a failed probe flips it to unhealthy without losing the row', async () => {
    await recordMcpTest(sql, {
      factory: FACTORY,
      server: SERVER,
      transport: 'stdio',
      ok: false,
      error: 'handshake failed',
    });

    const servers = await listMcpServers(sql, FACTORY);
    expect(servers.find((server) => server.name === SERVER)?.status).toBe('unhealthy');
  });
});
