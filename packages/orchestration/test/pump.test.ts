import { describe, expect, test } from 'bun:test';
import { FakeAdapter, type FactoryEvent, type PermissionDecision, type SessionHandle } from '@factory/adapters';
import { pumpSegment, type PumpDeps } from '../src/pump';

/**
 * Pump segment tests (ADR-013).
 *
 * The defect: a permission-blocked run used to keep an activity slot occupied. These tests
 * pin the new contract — a segment returns at `permission.requested`, the canonical event is
 * persisted exactly once, and resuming the same iterator continues to the terminal event.
 */

interface Recorder {
  deps: PumpDeps;
  persisted: FactoryEvent[];
  permissions: { requestId: string; action: string }[];
  forwarded: string[];
}

function recorder(
  adapter: FakeAdapter,
  handle: SessionHandle,
  overrides: Partial<PumpDeps> = {},
): Recorder {
  const persisted: FactoryEvent[] = [];
  const seen = new Set<number>();
  const permissions: { requestId: string; action: string }[] = [];
  const forwarded: string[] = [];

  const deps: PumpDeps = {
    append: async (event) => {
      if (seen.has(event.seq)) return { appended: false, seq: null };
      seen.add(event.seq);
      persisted.push(event);
      return { appended: true, seq: event.seq };
    },
    recordPermission: async (request) => {
      permissions.push({ requestId: request.requestId, action: request.action });
    },
    isCancelled: async () => false,
    respond: async (requestId, decision: PermissionDecision) => {
      forwarded.push(`${requestId}:${decision}`);
      await adapter.respondToPermission(handle, requestId, decision);
    },
    heartbeat: () => undefined,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };

  return { deps, persisted, permissions, forwarded };
}

async function openStream(adapter: FakeAdapter, runId: string) {
  const handle = await adapter.startSession({ runId });
  const controller = new AbortController();
  const iterator = adapter
    .streamEvents(handle, controller.signal)
    [Symbol.asyncIterator]();
  return { handle, controller, iterator };
}

describe('pump segment', () => {
  test('returns at permission.requested and persists the canonical event exactly once', async () => {
    const adapter = new FakeAdapter();
    const { handle, controller, iterator } = await openStream(adapter, 'run_pump_1');
    const rec = recorder(adapter, handle);

    const first = await pumpSegment({
      runId: 'run_pump_1',
      adapter,
      handle,
      iterator,
      signal: controller.signal,
      deps: rec.deps,
      tickMs: 5,
    });

    expect(first.stopReason).toBe('permission');
    expect(first.permissionRequestId).toBe('per_1');
    expect(first.permissionAction).toBe('bash');
    expect(first.appended).toBe(10);
    expect(first.lastSeq).toBe(10);
    expect(rec.persisted).toHaveLength(10);
    expect(rec.persisted.filter((event) => event.type === 'permission.requested')).toHaveLength(1);
    expect(rec.permissions).toEqual([{ requestId: 'per_1', action: 'bash' }]);
    // No decision was made yet, so nothing was forwarded to the harness.
    expect(rec.forwarded).toEqual([]);

    // A decision resolves the wait; the next segment resumes the same iterator.
    await adapter.respondToPermission(handle, 'per_1', 'allow');

    const second = await pumpSegment({
      runId: 'run_pump_1',
      adapter,
      handle,
      iterator,
      signal: controller.signal,
      fromSeq: first.lastSeq,
      deps: rec.deps,
      tickMs: 5,
    });

    expect(second.stopReason).toBe('terminal');
    expect(second.terminalStatus).toBe('ok');
    expect(second.appended).toBe(4);

    expect(rec.persisted).toHaveLength(14);
    expect(rec.persisted.filter((event) => event.type === 'permission.requested')).toHaveLength(1);
    expect(rec.persisted.filter((event) => event.type === 'run.completed')).toHaveLength(1);
    expect(rec.persisted.map((event) => event.seq)).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 1),
    );
  });

  test('deny is forwarded and the run still reaches a terminal event', async () => {
    const adapter = new FakeAdapter();
    const { handle, controller, iterator } = await openStream(adapter, 'run_pump_2');
    const rec = recorder(adapter, handle);

    const first = await pumpSegment({
      runId: 'run_pump_2',
      adapter,
      handle,
      iterator,
      signal: controller.signal,
      deps: rec.deps,
      tickMs: 5,
    });
    expect(first.stopReason).toBe('permission');

    await adapter.respondToPermission(handle, 'per_1', 'deny');

    const second = await pumpSegment({
      runId: 'run_pump_2',
      adapter,
      handle,
      iterator,
      signal: controller.signal,
      fromSeq: first.lastSeq,
      deps: rec.deps,
      tickMs: 5,
    });

    expect(second.stopReason).toBe('terminal');
    expect(second.terminalStatus).toBe('ok');
    const gated = rec.persisted.find(
      (event) => event.type === 'tool.call.completed' && event.callId === 'call_2',
    );
    expect(gated).toMatchObject({ ok: false });
  });

  test('a replayed permission with a durable decision is forwarded, not surfaced again', async () => {
    // Simulates a worker restart: a fresh adapter/iterator replays the script, but the
    // workflow already holds the decision for `per_1`.
    const adapter = new FakeAdapter();
    const { handle, controller, iterator } = await openStream(adapter, 'run_pump_3');
    const rec = recorder(adapter, handle);

    const result = await pumpSegment({
      runId: 'run_pump_3',
      adapter,
      handle,
      iterator,
      signal: controller.signal,
      decided: { per_1: 'allow' },
      deps: rec.deps,
      tickMs: 5,
    });

    expect(result.stopReason).toBe('terminal');
    expect(result.terminalStatus).toBe('ok');
    expect(rec.forwarded).toEqual(['per_1:allow']);
    expect(rec.persisted.filter((event) => event.type === 'permission.requested')).toHaveLength(1);
  });

  test('events at or below fromSeq are not persisted twice', async () => {
    const adapter = new FakeAdapter();
    const { handle, controller, iterator } = await openStream(adapter, 'run_pump_4');
    const rec = recorder(adapter, handle);

    const result = await pumpSegment({
      runId: 'run_pump_4',
      adapter,
      handle,
      iterator,
      signal: controller.signal,
      fromSeq: 10,
      decided: { per_1: 'allow' },
      deps: rec.deps,
      tickMs: 5,
    });

    expect(result.stopReason).toBe('terminal');
    expect(rec.persisted.map((event) => event.seq)).toEqual([11, 12, 13, 14]);
    expect(result.appended).toBe(4);
  });

  test('cooperative cancellation stops the segment as cancelled', async () => {
    const adapter = new FakeAdapter({ delayMs: 5 });
    const { handle, controller, iterator } = await openStream(adapter, 'run_pump_5');
    const rec = recorder(adapter, handle, { isCancelled: async () => true });

    const result = await pumpSegment({
      runId: 'run_pump_5',
      adapter,
      handle,
      iterator,
      signal: controller.signal,
      deps: rec.deps,
      tickMs: 1,
    });

    expect(result.stopReason).toBe('cancelled');
    expect(result.terminalStatus).toBe('cancelled');
  });
});
