import { describe, expect, test } from 'bun:test';
import { createSequencer, type FactoryEvent } from '@factory/adapters';
import { clearSessions, ensureSession } from '../src/sessions';
import type { RunInput } from '../src/types';

function fakeRun(overrides: Partial<RunInput> = {}): RunInput {
  return {
    runId: 'run_test_1',
    factory: 'example',
    factoryRoot: '/tmp/factories/example',
    definitionCommit: 'abc123',
    definitionDirty: false,
    harness: 'fake',
    model: 'fake/fake-model',
    runner: 'fake',
    prompt: { text: 'read the README' },
    kind: 'chat',
    proxyModels: ['fake/fake-model'],
    fakeDelayMs: 0,
    ...overrides,
  };
}

describe('session registry', () => {
  test('fake session emits the canonical scripted sequence', async () => {
    clearSessions();
    const input = fakeRun();
    const { adapter, handle } = await ensureSession(input);

    const events: FactoryEvent[] = [];
    const pending: Promise<void>[] = [];

    for await (const event of adapter.streamEvents(handle)) {
      events.push(event);
      if (event.type === 'permission.requested') {
        pending.push(adapter.respondToPermission(handle, event.requestId, 'allow'));
      }
    }
    await Promise.all(pending);

    expect(events[0].type).toBe('run.started');
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.filter((event) => event.type === 'run.completed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'permission.requested')).toHaveLength(1);

    // Strictly increasing seq per run (spec: ordering).
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test('ensureSession reuses the session for the same run', async () => {
    clearSessions();
    const input = fakeRun({ runId: 'run_test_2' });
    const first = await ensureSession(input);
    const second = await ensureSession(input);
    expect(second).toBe(first);
  });

  test('a fresh sequencer starts at 1 so retries replay identical seqs', () => {
    const sequencer = createSequencer();
    expect(sequencer.stamp({ type: 'message.delta', role: 'assistant', text: 'a' }).seq).toBe(1);
    expect(sequencer.stamp({ type: 'message.delta', role: 'assistant', text: 'b' }).seq).toBe(2);
  });
});
