import { describe, expect, test } from 'bun:test';
import {
  FACTORY_EVENT_TYPES,
  EventSequencer,
  factoryEventSchema,
  parseFactoryEvent,
  type FactoryEventInput,
} from '../src';

describe('canonical event union', () => {
  test('has exactly the eleven spec types', () => {
    expect(FACTORY_EVENT_TYPES).toHaveLength(11);
    expect(new Set(FACTORY_EVENT_TYPES).size).toBe(11);
    expect([...FACTORY_EVENT_TYPES].sort().join(',')).toBe(
      [
        'artifact.produced',
        'file.edited',
        'message.completed',
        'message.delta',
        'permission.requested',
        'run.completed',
        'run.started',
        'tool.call.args.delta',
        'tool.call.completed',
        'tool.call.started',
        'usage.updated',
      ]
        .sort()
        .join(','),
    );
  });

  test('every variant validates through the discriminated union', () => {
    const sequencer = new EventSequencer({ clock: () => 1 });
    const bodies: FactoryEventInput[] = [
      { type: 'run.started', runId: 'r1', harness: 'fake', model: 'm' },
      { type: 'message.delta', role: 'assistant', text: 'hi' },
      { type: 'message.completed', role: 'assistant', text: 'hi' },
      { type: 'tool.call.started', callId: 'c1', name: 'bash', args: {} },
      { type: 'tool.call.args.delta', callId: 'c1', delta: '{}' },
      { type: 'tool.call.completed', callId: 'c1', result: { ok: true }, ok: true },
      { type: 'permission.requested', requestId: 'p1', action: 'bash', detail: { a: 1 } },
      { type: 'file.edited', path: 'a.ts', diff: '@@' },
      { type: 'artifact.produced', path: 'patch.diff', kind: 'patch', bytes: 12 },
      { type: 'usage.updated', inputTokens: 1, outputTokens: 2, costUsd: 0.01 },
      { type: 'run.completed', status: 'ok' },
    ];

    const events = sequencer.stampAll(bodies);
    expect(events).toHaveLength(11);
    for (const event of events) {
      expect(factoryEventSchema.safeParse(event).success).toBe(true);
    }
    expect(events.map((event) => event.type)).toEqual([...FACTORY_EVENT_TYPES]);
  });

  test('assigns strictly increasing seq per run', () => {
    const sequencer = new EventSequencer();
    const first = sequencer.stamp({ type: 'message.delta', role: 'assistant', text: 'a' });
    const second = sequencer.stamp({ type: 'message.delta', role: 'assistant', text: 'b' });
    const third = sequencer.stamp({ type: 'run.completed', status: 'ok' });

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
    expect(sequencer.lastSeq).toBe(3);
  });

  test('respects a start offset and stamps at from the clock', () => {
    const sequencer = new EventSequencer({ startAt: 41, clock: () => 1234 });
    const event = sequencer.stamp({ type: 'run.completed', status: 'error', summary: 'boom' });
    expect(event.seq).toBe(42);
    expect(event.at).toBe(1234);
  });

  test('rejects events with unknown types or missing envelope fields', () => {
    expect(factoryEventSchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(factoryEventSchema.safeParse({ type: 'run.completed', status: 'ok' }).success).toBe(false);
    expect(
      factoryEventSchema.safeParse({ type: 'run.completed', seq: 1, at: 1, status: 'weird' })
        .success,
    ).toBe(false);
    expect(
      factoryEventSchema.safeParse({
        type: 'message.delta',
        seq: 1,
        at: 1,
        role: 'assistant',
        text: 'x',
        extra: true,
      }).success,
    ).toBe(false);
  });

  test('parseFactoryEvent returns undefined for unknown payloads', () => {
    expect(parseFactoryEvent({ type: 'unknown.event' })).toBeUndefined();
    expect(
      parseFactoryEvent({ type: 'run.completed', seq: 7, at: 9, status: 'cancelled' }),
    ).toMatchObject({ type: 'run.completed', seq: 7, status: 'cancelled' });
  });
});
