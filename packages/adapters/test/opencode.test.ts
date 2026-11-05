import { describe, expect, test } from 'bun:test';
import {
  AdapterError,
  OpencodeAdapter,
  SseParser,
  createOpencodeMapper,
  parseSseString,
  type FactoryEvent,
  type OpencodeTransport,
} from '../src';
import { FIXTURE_SESSION, ReplayTransport, loadFixture } from './replay';

const TINY_SSE = `data: {"id":"evt_1","type":"server.connected","data":{}}

data: {"id":"evt_2","type":"session.idle","data":{"sessionID":"${FIXTURE_SESSION}"}}
`;

describe('SSE parser', () => {
  test('parses frames split across chunks and ignores heartbeats', () => {
    const parser = new SseParser();
    expect(parser.push(': heartbeat\n\n')).toEqual([]);

    const first = parser.push('data: {"a":1}\n\n');
    expect(first).toHaveLength(1);
    expect(first[0].data).toBe('{"a":1}');

    expect(parser.push('id: 7\nevent: session.idle\ndata: {"b":')).toEqual([]);
    const rest = parser.push('2}\n\n');
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ id: '7', event: 'session.idle', data: '{"b":2}' });
    expect(parser.lastId).toBe('7');
  });

  test('handles CRLF and flushes an unterminated trailing frame', () => {
    const frames = parseSseString('data: {"x":1}\r\n\r\ndata: {"y":2}');
    expect(frames.map((frame) => frame.data)).toEqual(['{"x":1}', '{"y":2}']);
  });
});

describe('OpencodeAdapter readiness', () => {
  test('retries with backoff until /api/info answers', async () => {
    const transport = new ReplayTransport({ sse: TINY_SSE, failures: 2 });
    const adapter = new OpencodeAdapter({
      baseUrl: 'http://fixture',
      transport,
      readiness: { timeoutMs: 2_000, initialDelayMs: 5, maxDelayMs: 10 },
    });

    await expect(adapter.probe()).resolves.toMatchObject({ version: '2.0.26-fixture' });
    expect(transport.calls).toHaveLength(3);
  });

  test('maps an unreachable server to harness_unreachable', async () => {
    const transport = new ReplayTransport({ sse: TINY_SSE, failures: 1_000 });
    const adapter = new OpencodeAdapter({
      baseUrl: 'http://127.0.0.1:1',
      transport,
      readiness: { timeoutMs: 60, initialDelayMs: 5, maxDelayMs: 10 },
    });

    try {
      await adapter.startSession({ runId: 'run_down' });
      throw new Error('expected startSession to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      const adapterError = error as AdapterError;
      expect(adapterError.code).toBe('harness_unreachable');
      expect(adapterError.toJSON()).toMatchObject({ code: 'harness_unreachable' });
    }
  });
});

describe('OpencodeAdapter terminal status', () => {
  test('reports a failed session with the provider error', async () => {
    const transport: OpencodeTransport = {
      async request<T>(method: string, path: string): Promise<T> {
        if (method === 'GET' && path === '/api/session/ses_failed') {
          return { data: { id: 'ses_failed', outcome: 'failed' } } as T;
        }
        if (method === 'GET' && path === '/api/session/ses_failed/message') {
          return {
            data: [
              { type: 'assistant', error: { message: 'Model unavailable: factory/best_llm' } },
            ],
          } as T;
        }
        throw new AdapterError('harness_error', `unexpected ${method} ${path}`);
      },
      async *stream(): AsyncIterable<unknown> {
        // not used by getStatus
      },
    };
    const adapter = new OpencodeAdapter({ baseUrl: 'http://fixture', transport });

    await expect(
      adapter.getStatus({ adapterId: 'opencode', runId: 'run_failed', sessionRef: 'ses_failed' }),
    ).resolves.toEqual({
      terminal: true,
      status: 'error',
      summary: 'Model unavailable: factory/best_llm',
    });
  });

  test('leaves a running session non-terminal', async () => {
    const transport: OpencodeTransport = {
      async request<T>(method: string, path: string): Promise<T> {
        if (method === 'GET' && path === '/api/session/ses_running') {
          return { data: { id: 'ses_running' } } as T;
        }
        throw new AdapterError('harness_error', `unexpected ${method} ${path}`);
      },
      async *stream(): AsyncIterable<unknown> {},
    };
    const adapter = new OpencodeAdapter({ baseUrl: 'http://fixture', transport });

    await expect(
      adapter.getStatus({ adapterId: 'opencode', runId: 'run_running', sessionRef: 'ses_running' }),
    ).resolves.toEqual({ terminal: false });
  });
});

describe('OpencodeAdapter mapping', () => {
  test('drops unknown payloads and counts them without failing', () => {
    const mapper = createOpencodeMapper({ runId: 'r', sessionRef: FIXTURE_SESSION });
    expect(mapper.map({ type: 'totally.new.event', data: {} })).toEqual([]);
    expect(mapper.map(null)).toEqual([]);
    expect(mapper.map({ data: {} })).toEqual([]);
    expect(mapper.stats.dropped).toBe(3);

    expect(mapper.map({ type: 'server.connected', data: {} })).toEqual([]);
    expect(mapper.stats.dropped).toBe(3);
  });

  test('ignores events from another session', () => {
    const mapper = createOpencodeMapper({ runId: 'r', sessionRef: FIXTURE_SESSION });
    const bodies = mapper.map({
      type: 'session.next.text.delta',
      data: { sessionID: 'ses_other', delta: 'nope' },
    });
    expect(bodies).toEqual([]);
    expect(mapper.stats.dropped).toBe(0);
  });

  test('maps tool failure to ok:false and step failure to an error terminal', () => {
    const mapper = createOpencodeMapper({ runId: 'r', sessionRef: FIXTURE_SESSION });
    expect(
      mapper.map({
        type: 'session.next.tool.failed',
        data: { sessionID: FIXTURE_SESSION, callID: 'c1', error: { message: 'boom' } },
      }),
    ).toEqual([{ type: 'tool.call.completed', callId: 'c1', ok: false, result: { error: { message: 'boom' } } }]);

    mapper.map({
      type: 'session.next.step.failed',
      data: { sessionID: FIXTURE_SESSION, error: { message: 'provider down' } },
    });
    expect(mapper.map({ type: 'session.idle', data: { sessionID: FIXTURE_SESSION } })).toEqual([
      { type: 'run.completed', status: 'error', summary: 'provider down' },
    ]);
  });

  test('cancel turns session.idle into a cancelled terminal event', () => {
    const mapper = createOpencodeMapper({ runId: 'r', sessionRef: FIXTURE_SESSION });
    mapper.markCancelled();
    expect(mapper.map({ type: 'session.idle', data: { sessionID: FIXTURE_SESSION } })).toEqual([
      { type: 'run.completed', status: 'cancelled', summary: 'cancelled' },
    ]);
  });

  test('maps opencode 2.2 `session.*` events from a real run to canonical events', () => {
    // Payloads captured from `opencode serve` 2.2.0 against the LiteLLM proxy. 2.2 renamed
    // the bus events (`session.next.*` → `session.*`) and moved the tool call id to `id`;
    // before this, a real run produced only `run.started` and never reached a terminal state.
    const session = FIXTURE_SESSION;
    const mapper = createOpencodeMapper({ runId: 'r', sessionRef: session });

    expect(
      mapper.map({ type: 'session.step.started', data: { sessionID: session, agent: 'build' } }),
    ).toEqual([]);

    expect(
      mapper.map({
        type: 'session.text.delta',
        data: { sessionID: session, assistantMessageID: 'm1', delta: 'Done' },
      }),
    ).toEqual([{ type: 'message.delta', role: 'assistant', text: 'Done' }]);

    expect(
      mapper.map({
        type: 'session.tool.input.started',
        data: { sessionID: session, id: 'call_1', name: 'shell' },
      }),
    ).toEqual([{ type: 'tool.call.started', callId: 'call_1', name: 'shell', args: {} }]);

    expect(
      mapper.map({
        type: 'session.tool.called',
        data: { sessionID: session, id: 'call_1', input: { command: 'ls -la' }, executed: false },
      }),
    ).toEqual([]); // already announced by `session.tool.input.started`

    expect(
      mapper.map({
        type: 'session.tool.success',
        data: { sessionID: session, id: 'call_1', content: [{ type: 'text', text: 'total 8' }] },
      }),
    ).toEqual([
      {
        type: 'tool.call.completed',
        callId: 'call_1',
        ok: true,
        result: { structured: {}, content: [{ type: 'text', text: 'total 8' }] },
      },
    ]);

    expect(
      mapper.map({
        type: 'session.step.ended',
        data: {
          sessionID: session,
          finish: 'stop',
          tokens: { input: 1307, output: 21, reasoning: 1, cache: { read: 4096, write: 0 } },
          cost: 0,
        },
      }),
    ).toEqual([
      {
        type: 'usage.updated',
        inputTokens: 1307,
        outputTokens: 21,
        costUsd: 0,
        cacheReadTokens: 4096,
        reasoningTokens: 1,
      },
    ]);

    // The session total arrives last and overwrites the per-step numbers.
    expect(
      mapper.map({
        type: 'session.usage.updated',
        data: { sessionID: session, cost: 0, tokens: { input: 2500, output: 60, cache: { read: 8192 } } },
      }),
    ).toMatchObject([{ type: 'usage.updated', inputTokens: 2500, outputTokens: 60 }]);

    expect(
      mapper.map({ type: 'session.text.ended', data: { sessionID: session, text: 'Done.' } }),
    ).toEqual([{ type: 'message.completed', role: 'assistant', text: 'Done.' }]);

    expect(
      mapper.map({ type: 'session.execution.succeeded', data: { sessionID: session } }),
    ).toEqual([{ type: 'run.completed', status: 'ok', summary: 'Done.' }]);
    expect(mapper.finished).toBe(true);
  });

  test('a v2.2 execution failure ends the run with the provider error', () => {
    const mapper = createOpencodeMapper({ runId: 'r', sessionRef: FIXTURE_SESSION });
    expect(
      mapper.map({
        type: 'session.execution.failed',
        data: {
          sessionID: FIXTURE_SESSION,
          error: { type: 'provider.auth', message: 'unknown run token', status: 401 },
        },
      }),
    ).toEqual([{ type: 'run.completed', status: 'error', summary: 'unknown run token' }]);
  });

  test('file.edited without a diff still maps to a canonical file.edited', () => {
    const mapper = createOpencodeMapper({ runId: 'r', sessionRef: FIXTURE_SESSION });
    expect(mapper.map({ type: 'file.edited', data: { file: 'src/a.ts' } })).toEqual([
      { type: 'file.edited', path: 'src/a.ts', diff: '' },
    ]);
  });
});

describe('OpencodeAdapter operations', () => {
  async function adapterWithFixture() {
    const sse = await loadFixture('opencode-run.sse');
    const transport = new ReplayTransport({ sse });
    const adapter = new OpencodeAdapter({ baseUrl: 'http://fixture', transport });
    return { adapter, transport };
  }

  test('startSession creates a v2 session and exposes its model', async () => {
    const { adapter, transport } = await adapterWithFixture();
    const handle = await adapter.startSession({ runId: 'run_1' });

    expect(handle).toMatchObject({
      adapterId: 'opencode',
      runId: 'run_1',
      sessionRef: FIXTURE_SESSION,
      harnessUrl: 'http://fixture',
      model: 'fake/fake-model',
    });
    expect(transport.calls[0]).toMatchObject({ method: 'GET', path: '/api/info' });
    expect(transport.calls[1]).toMatchObject({ method: 'POST', path: '/api/session' });
  });

  test('permission decisions map to v2 reply values', async () => {
    const { adapter, transport } = await adapterWithFixture();
    const handle = await adapter.startSession({ runId: 'run_2' });

    await adapter.respondToPermission(handle, 'per_1', 'allow');
    await adapter.respondToPermission(handle, 'per_1', 'always');
    await adapter.respondToPermission(handle, 'per_1', 'deny');

    const replies = transport.calls
      .filter((call) => call.path.endsWith('/reply'))
      .map((call) => call.body);
    expect(replies).toEqual([{ decision: 'once' }, { decision: 'always' }, { decision: 'reject' }]);
  });

  test('diff, usage and agents are mapped from v2 shapes', async () => {
    const { adapter } = await adapterWithFixture();
    const handle = await adapter.startSession({ runId: 'run_3' });

    expect(await adapter.getDiff(handle)).toEqual([
      {
        path: 'README.md',
        diff: '@@ -1 +1 @@\n-# Factory\n+# Factory\n',
        status: 'modified',
        additions: 1,
        deletions: 1,
      },
    ]);
    expect(await adapter.getUsage(handle)).toMatchObject({
      inputTokens: 1200,
      outputTokens: 80,
      costUsd: 0.0021,
    });
    expect(await adapter.listAgents(handle)).toEqual([
      expect.objectContaining({ id: 'build', name: 'Build', mode: 'primary' }),
    ]);
  });

  test('structured output is rejected because the capability is false', async () => {
    const { adapter } = await adapterWithFixture();
    const handle = await adapter.startSession({ runId: 'run_4' });

    await expect(
      adapter.sendPrompt(handle, [{ type: 'text', text: 'x' }], {
        structuredOutput: { schema: { type: 'object' } },
      }),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
  });

  test('cancel calls the interrupt endpoint', async () => {
    const { adapter, transport } = await adapterWithFixture();
    const handle = await adapter.startSession({ runId: 'run_5' });
    await adapter.cancel(handle, 'test');

    expect(transport.calls.some((call) => call.path.endsWith('/interrupt'))).toBe(true);
  });

  test('resume validates an existing session and fork creates a new one', async () => {
    const { adapter } = await adapterWithFixture();
    const handle = await adapter.startSession({ runId: 'run_6' });

    const resumed = await adapter.resume(handle);
    expect(resumed.sessionRef).toBe(FIXTURE_SESSION);

    const forked = await adapter.fork!(handle, 'msg_1');
    expect(forked.sessionRef).toBe(`${FIXTURE_SESSION}_fork`);
    expect(forked.meta?.forkedFrom).toBe(FIXTURE_SESSION);
  });

  test('a bare model name is addressed on the factory proxy provider', async () => {
    // Regression: `best_llm` has no `provider/model` prefix. Leaving it unset let opencode
    // fall back to its built-in default (gpt-6.1-terra → api.openai.com) instead of the
    // per-run proxy, so a run answered with the wrong model from the wrong endpoint.
    const { adapter, transport } = await adapterWithFixture();
    const handle = await adapter.startSession({
      runId: 'run_model',
      model: 'best_llm',
    });

    const session = transport.calls.find((call) => call.path === '/api/session');
    expect(session?.body).toMatchObject({
      model: { providerID: 'factory', id: 'best_llm' },
    });

    await adapter.sendPrompt(handle, [{ type: 'text', text: 'hi' }], { model: 'best_llm' });
    const prompt = transport.calls.find((call) => call.path.endsWith('/prompt'));
    expect(prompt?.body).toMatchObject({ model: { providerID: 'factory', id: 'best_llm' } });

    // A prefixed ref keeps its own provider.
    await adapter.sendPrompt(handle, [{ type: 'text', text: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    });
    const prefixed = transport.calls.filter((call) => call.path.endsWith('/prompt')).at(-1);
    expect(prefixed?.body).toMatchObject({
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
    });
  });

  test('a stream that closes without a terminal event ends with status error', async () => {
    const transport = new ReplayTransport({
      sse: `data: {"id":"evt_1","type":"server.connected","data":{}}\n\n`,
    });
    const adapter = new OpencodeAdapter({ baseUrl: 'http://fixture', transport });
    const handle = await adapter.startSession({ runId: 'run_7' });

    const events: FactoryEvent[] = [];
    for await (const event of adapter.streamEvents(handle)) events.push(event);

    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'error' });
    expect(events[0]).toMatchObject({ type: 'run.started', harness: 'opencode' });
  });
});
