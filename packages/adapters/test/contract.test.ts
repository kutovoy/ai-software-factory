import { describe, expect, test } from 'bun:test';
import {
  FakeAdapter,
  OpencodeAdapter,
  type FactoryEvent,
  type HarnessAdapter,
  type PermissionDecision,
} from '../src';
import { FIXTURE_SESSION, ReplayTransport, loadFixture } from './replay';

/**
 * Runs the same scenario through any adapter: start a session, consume the stream,
 * answer the first permission request, then send the prompt.
 */
async function runScenario(
  adapter: HarnessAdapter,
  decision: PermissionDecision = 'allow',
): Promise<FactoryEvent[]> {
  const handle = await adapter.startSession({ runId: 'run_fixture' });
  const events: FactoryEvent[] = [];

  const consumer = (async () => {
    for await (const event of adapter.streamEvents(handle)) {
      events.push(event);
      if (event.type === 'permission.requested') {
        await adapter.respondToPermission(handle, event.requestId, decision);
      }
    }
  })();

  await adapter.sendPrompt(handle, [{ type: 'text', text: 'read the readme' }]);
  await consumer;
  return events;
}

/**
 * Normalises everything that legitimately differs between two harnesses:
 * wall-clock timestamps, ids minted by the harness, the run id and the harness name.
 * Sequence numbers and payload shapes must match exactly.
 */
function normalize(events: FactoryEvent[]): unknown[] {
  const ids = new Map<string, string>();
  const stableId = (value: string): string => {
    const existing = ids.get(value);
    if (existing) return existing;
    const replacement = `<id:${ids.size}>`;
    ids.set(value, replacement);
    return replacement;
  };

  return events.map((event) => {
    const { at: _at, ...rest } = event;
    const record = rest as Record<string, unknown>;

    if (typeof record.runId === 'string') record.runId = '<run>';
    if (typeof record.harness === 'string') record.harness = '<harness>';
    if (typeof record.callId === 'string') record.callId = stableId(record.callId);
    if (typeof record.requestId === 'string') record.requestId = stableId(record.requestId);

    return record;
  });
}

describe('adapter contract', () => {
  test('fake and recorded opencode fixture produce the same canonical sequence', async () => {
    const sse = await loadFixture('opencode-run.sse');
    const transport = new ReplayTransport({ sse });
    const opencode = new OpencodeAdapter({ baseUrl: 'http://fixture', transport });
    const fake = new FakeAdapter();

    const fakeEvents = await runScenario(fake);
    const opencodeEvents = await runScenario(opencode);

    expect(opencodeEvents).toHaveLength(fakeEvents.length);
    expect(normalize(opencodeEvents)).toEqual(normalize(fakeEvents));
  });

  test('both adapters map a denied permission to ok:false', async () => {
    const sse = await loadFixture('opencode-run-denied.sse');
    const transport = new ReplayTransport({ sse });
    const opencode = new OpencodeAdapter({ baseUrl: 'http://fixture', transport });
    const fake = new FakeAdapter();

    const fakeEvents = await runScenario(fake, 'deny');
    const opencodeEvents = await runScenario(opencode, 'deny');

    expect(normalize(opencodeEvents)).toEqual(normalize(fakeEvents));
    expect(
      opencodeEvents.find(
        (event) => event.type === 'tool.call.completed' && event.callId === 'call_2',
      ),
    ).toMatchObject({ ok: false });
  });

  test('opencode replay uses the v2 endpoints', async () => {
    const sse = await loadFixture('opencode-run.sse');
    const transport = new ReplayTransport({ sse });
    const adapter = new OpencodeAdapter({ baseUrl: 'http://fixture', transport });

    await runScenario(adapter);

    const paths = transport.calls.map((call) => `${call.method} ${call.path}`);
    expect(paths).toContain('GET /api/info');
    expect(paths).toContain('POST /api/session');
    expect(paths).toContain(`POST /api/session/${FIXTURE_SESSION}/prompt`);
    expect(paths).toContain(`POST /api/session/${FIXTURE_SESSION}/permission/per_1/reply`);

    const reply = transport.calls.find((call) => call.path.endsWith('/reply'));
    expect(reply?.body).toEqual({ decision: 'once' });
  });
});
