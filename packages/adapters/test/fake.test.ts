import { describe, expect, test } from 'bun:test';
import { AdapterError, FakeAdapter, isAdapterError, type FactoryEvent } from '../src';

async function collect(
  adapter: FakeAdapter,
  decision: 'allow' | 'deny' | 'always',
  signal?: AbortSignal,
): Promise<FactoryEvent[]> {
  const handle = await adapter.startSession({ runId: 'run_fake' });
  const events: FactoryEvent[] = [];
  const consumer = (async () => {
    for await (const event of adapter.streamEvents(handle, signal)) {
      events.push(event);
      if (event.type === 'permission.requested') {
        await adapter.respondToPermission(handle, event.requestId, decision);
      }
    }
  })();
  await adapter.sendPrompt(handle, [{ type: 'text', text: 'do the thing' }]);
  await consumer;
  return events;
}

describe('FakeAdapter', () => {
  test('emits the deterministic happy path', async () => {
    const adapter = new FakeAdapter();
    const events = await collect(adapter, 'allow');

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.delta',
      'message.delta',
      'message.completed',
      'tool.call.started',
      'tool.call.args.delta',
      'tool.call.completed',
      'tool.call.started',
      'tool.call.args.delta',
      'permission.requested',
      'tool.call.completed',
      'file.edited',
      'usage.updated',
      'run.completed',
    ]);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );

    const terminal = events.at(-1)!;
    expect(terminal).toMatchObject({ type: 'run.completed', status: 'ok' });
    expect(adapter.getStats()).toEqual({ droppedEvents: 0, emittedEvents: events.length });
  });

  test('deny completes the gated tool call with ok:false', async () => {
    const adapter = new FakeAdapter();
    const events = await collect(adapter, 'deny');

    const gated = events.find(
      (event) => event.type === 'tool.call.completed' && event.callId === 'call_2',
    );
    expect(gated).toMatchObject({ ok: false });
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'ok' });
  });

  test('cancel stops the run and emits a cancelled terminal event', async () => {
    const adapter = new FakeAdapter({ delayMs: 5 });
    const handle = await adapter.startSession({ runId: 'run_cancel' });
    const events: FactoryEvent[] = [];

    const consumer = (async () => {
      for await (const event of adapter.streamEvents(handle)) {
        events.push(event);
        if (event.type === 'message.delta') await adapter.cancel(handle, 'user cancelled');
      }
    })();
    await adapter.sendPrompt(handle, [{ type: 'text', text: 'long task' }]);
    await consumer;

    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'cancelled' });
    expect(events.some((event) => event.type === 'run.completed')).toBe(true);
  });

  test('abort signal also terminates the stream', async () => {
    const adapter = new FakeAdapter({ delayMs: 5 });
    const controller = new AbortController();
    const handle = await adapter.startSession({ runId: 'run_abort' });
    const events: FactoryEvent[] = [];

    const consumer = (async () => {
      for await (const event of adapter.streamEvents(handle, controller.signal)) {
        events.push(event);
        if (event.type === 'message.delta') controller.abort();
      }
    })();
    await adapter.sendPrompt(handle, [{ type: 'text', text: 'long task' }]);
    await consumer;

    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'cancelled' });
  });

  test('declares interactive permissions and no resume/fork', () => {
    const adapter = new FakeAdapter();
    expect(adapter.capabilities.permissions).toBe('interactive');
    expect(adapter.capabilities.resume).toBe(false);
    expect(adapter.capabilities.fork).toBe(false);
  });

  test('resume fails with unsupported_capability', async () => {
    const adapter = new FakeAdapter();
    const handle = await adapter.startSession({ runId: 'run_resume' });
    try {
      await adapter.resume(handle);
      throw new Error('expected resume to fail');
    } catch (error) {
      expect(isAdapterError(error)).toBe(true);
      expect((error as AdapterError).code).toBe('unsupported_capability');
    }
  });

  test('unknown permission request id is rejected', async () => {
    const adapter = new FakeAdapter();
    const handle = await adapter.startSession({ runId: 'run_perm' });
    await expect(adapter.respondToPermission(handle, 'nope', 'allow')).rejects.toMatchObject({
      code: 'permission_not_found',
    });
  });

  test('diff, usage and agents are available', async () => {
    const adapter = new FakeAdapter();
    const handle = await adapter.startSession({ runId: 'run_meta' });
    expect(await adapter.getDiff(handle)).toHaveLength(1);
    expect(await adapter.getUsage(handle)).toMatchObject({ inputTokens: 1200 });
    expect(await adapter.listAgents(handle)).toHaveLength(2);
  });
});
