import { describe, expect, test } from 'bun:test';
import { FakeAdapter, OpencodeAdapter, buildOpencodeSessionConfig, type McpSessionWiring } from '../src';
import { ReplayTransport, loadFixture } from './replay';

/**
 * MCP session config contract (change `add-secrets-and-mcp`, tasks 4.1–4.3).
 *
 * Uses a recorded wiring fixture: the payload must match the documented opencode config
 * shape (https://opencode.ai/docs/mcp-servers/, https://opencode.ai/docs/permissions/) and
 * must never contain a secret value — credentials travel as `{env:NAME}` templates.
 */

const SECRET_VALUE = 'ghp_recorded_fixture_value_should_never_appear';

async function wiringFixture(): Promise<McpSessionWiring> {
  const raw = await loadFixture('mcp-wiring.json');
  return JSON.parse(raw) as McpSessionWiring;
}

describe('opencode MCP session config', () => {
  test('renders stdio/remote servers and per-agent permission globs', async () => {
    const wiring = await wiringFixture();
    const config = buildOpencodeSessionConfig(wiring);

    expect(config.mcp).toEqual({
      github: {
        type: 'local',
        command: ['github-mcp', '--stdio'],
        environment: { GITHUB_TOKEN: '{env:GITHUB_TOKEN}' },
        enabled: true,
      },
      docs: {
        type: 'remote',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: '{env:DOCS_MCP_TOKEN}' },
        enabled: true,
      },
    });

    // Bound server allowed, unbound server explicitly denied (last-match-wins globs).
    expect(config.permission).toEqual({ 'github*': 'allow', 'docs*': 'deny' });
    expect(config.agent).toEqual({
      implement: { permission: { 'github*': 'allow', 'docs*': 'deny' } },
    });
  });

  test('an agent with no binding receives no servers but an explicit deny', () => {
    const config = buildOpencodeSessionConfig({
      servers: [],
      permissions: { 'github*': 'deny', 'docs*': 'deny' },
      agent: 'review',
    });
    expect(config.mcp).toEqual({});
    expect(config.permission).toEqual({ 'github*': 'deny', 'docs*': 'deny' });
    expect(config.agent).toEqual({
      review: { permission: { 'github*': 'deny', 'docs*': 'deny' } },
    });
  });

  test('the session request carries the config and no secret value', async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = SECRET_VALUE;
    try {
      const wiring = await wiringFixture();
      const sse = await loadFixture('opencode-run.sse');
      const transport = new ReplayTransport({ sse });
      const adapter = new OpencodeAdapter({ baseUrl: 'http://fixture', transport });

      const handle = await adapter.startSession({ runId: 'run_mcp', agent: 'implement', mcp: wiring });

      const create = transport.calls.find(
        (call) => call.method === 'POST' && call.path === '/api/session',
      );
      expect(create).toBeDefined();
      const body = create?.body as { agent?: string; config?: unknown };
      expect(body.agent).toBe('implement');

      const config = body.config as ReturnType<typeof buildOpencodeSessionConfig>;
      expect(config.mcp.github).toMatchObject({ type: 'local', enabled: true });
      expect(config.permission).toEqual({ 'github*': 'allow', 'docs*': 'deny' });

      // The whole payload: names, templates, globs — never a value.
      const payload = JSON.stringify(create?.body ?? {});
      expect(payload).not.toContain(SECRET_VALUE);
      expect(payload).toContain('{env:GITHUB_TOKEN}');
      expect(payload).toContain('{env:DOCS_MCP_TOKEN}');

      // The handle records what was applied (the UI/run detail can show it).
      expect(handle.meta?.mcp).toMatchObject({
        supported: true,
        agent: 'implement',
        servers: ['github', 'docs'],
        permissions: { 'github*': 'allow', 'docs*': 'deny' },
      });
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  test('a harness without MCP support records the request as capability flags', async () => {
    const wiring = await wiringFixture();
    const fake = new FakeAdapter();
    expect(fake.capabilities.mcp).toBe(false);

    const handle = await fake.startSession({ runId: 'run_mcp_fake', mcp: wiring });
    expect(handle.meta?.mcp).toEqual({
      supported: false,
      mode: 'recorded',
      servers: ['github', 'docs'],
      permissions: { 'github*': 'allow', 'docs*': 'deny' },
    });
    // Recorded only: the scripted harness emits the same canonical sequence.
    expect(fake.getStats().emittedEvents).toBe(0);
  });
});
