import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter, type FactoryEvent } from '@factory/adapters';
import {
  RunnerError,
  collectMetrics,
  createAdapterForAgent,
  pumpJobEvents,
  resolveAgentConfig,
  runAgent,
  type PumpSource,
  type PumpState,
} from '../src';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Agent-side tests. No Docker, no network, no harness process: metrics are sampled from
 * the host, and the pump is exercised against the deterministic fake adapter and manual
 * async sources.
 */

function emptyState(): PumpState {
  return { events: [], pendingNext: null, lastSeq: 0, terminal: false };
}

describe('collectMetrics', () => {
  test('returns a complete, well-typed sample without throwing', async () => {
    const metrics = await collectMetrics('1.2.3-test');

    expect(metrics.agentVersion).toBe('1.2.3-test');
    expect(typeof metrics.capturedAt).toBe('string');
    expect(Number.isNaN(Date.parse(metrics.capturedAt))).toBe(false);

    expect(Number.isFinite(metrics.cpuPercent)).toBe(true);
    expect(metrics.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(metrics.cpuPercent).toBeLessThanOrEqual(100);

    expect(Number.isFinite(metrics.load1)).toBe(true);
    expect(Number.isFinite(metrics.load5)).toBe(true);
    expect(Number.isFinite(metrics.load15)).toBe(true);

    expect(metrics.memoryTotalBytes).toBeGreaterThan(0);
    expect(metrics.memoryUsedBytes).toBeGreaterThanOrEqual(0);
    expect(metrics.memoryAvailableBytes).toBeGreaterThanOrEqual(0);
    expect(metrics.memoryUsedBytes + metrics.memoryAvailableBytes).toBe(metrics.memoryTotalBytes);
    expect(metrics.memoryUsedPercent).toBeGreaterThanOrEqual(0);
    expect(metrics.memoryUsedPercent).toBeLessThanOrEqual(100);

    expect(Array.isArray(metrics.disks)).toBe(true);
    for (const disk of metrics.disks) {
      expect(typeof disk.mount).toBe('string');
      expect(disk.mount.length).toBeGreaterThan(0);
      expect(disk.totalBytes).toBeGreaterThan(0);
      expect(disk.freeBytes).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(disk.usedPercent)).toBe(true);
      expect(disk.usedPercent).toBeGreaterThanOrEqual(0);
      if (disk.inodeUsedPercent !== undefined) {
        expect(disk.inodeUsedPercent).toBeGreaterThanOrEqual(0);
      }
    }

    if (metrics.uptimeSeconds !== undefined) expect(metrics.uptimeSeconds).toBeGreaterThan(0);
    if (metrics.processCount !== undefined) expect(metrics.processCount).toBeGreaterThan(0);
  }, 20_000);
});

describe('createAdapterForAgent', () => {
  test('builds a fake adapter', () => {
    const adapter = createAdapterForAgent('fake', { delayMs: 0 });
    expect(adapter.id).toBe('fake');
  });

  test('rejects an unsupported harness with runner_unavailable', () => {
    try {
      createAdapterForAgent('claude-code');
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RunnerError);
      expect((error as RunnerError).code).toBe('runner_unavailable');
      expect((error as RunnerError).message).toContain('unsupported harness');
    }
  });

  test('requires a base URL for opencode', () => {
    expect(() => createAdapterForAgent('opencode')).toThrow(RunnerError);
    const adapter = createAdapterForAgent('opencode', { baseUrl: 'http://127.0.0.1:4096' });
    expect(adapter.id).toBe('opencode');
  });
});

describe('pumpJobEvents', () => {
  test('stops on permission and resumes from the same iterator when decided', async () => {
    const adapter = new FakeAdapter({ delayMs: 0 });
    const session = await adapter.startSession({ runId: 'run-pump' });
    const controller = new AbortController();
    const iterator = adapter
      .streamEvents(session, controller.signal)
      [Symbol.asyncIterator]();
    await adapter.sendPrompt(session, [{ type: 'text', text: 'go' }]);

    const source: PumpSource = {
      next: () => iterator.next(),
      respond: (requestId, decision) =>
        adapter.respondToPermission(session, requestId, decision),
      stats: () => adapter.getStats(),
    };
    const state = emptyState();

    const first = await pumpJobEvents(state, source, { waitMs: 2_000 });
    expect(first.stopReason).toBe('permission');
    expect(first.permissionRequestId).toBe('per_1');
    expect(first.permissionAction).toBe('bash');
    expect(first.lastSeq).toBeGreaterThan(0);
    const firstEvents = first.events as FactoryEvent[];
    expect(firstEvents.some((event) => event.type === 'run.started')).toBe(true);
    expect(firstEvents.some((event) => event.type === 'permission.requested')).toBe(true);
    expect(first.terminalStatus).toBeUndefined();

    const second = await pumpJobEvents(state, source, {
      fromSeq: first.lastSeq,
      decided: { per_1: 'allow' },
      waitMs: 2_000,
    });
    expect(second.stopReason).toBe('terminal');
    expect(second.terminalStatus).toBe('ok');
    expect(second.costUsd).toBeCloseTo(0.0021, 6);
    const secondEvents = second.events as FactoryEvent[];
    expect(secondEvents.length).toBeGreaterThan(0);
    expect(secondEvents.every((event) => event.seq > first.lastSeq)).toBe(true);
    expect(secondEvents.some((event) => event.type === 'run.completed')).toBe(true);

    // Terminal jobs short-circuit on later pumps.
    const third = await pumpJobEvents(state, source, { fromSeq: second.lastSeq, waitMs: 1_000 });
    expect(third.stopReason).toBe('terminal');
    expect(third.terminalStatus).toBe('ok');
    expect(third.events).toEqual([]);

    await adapter.dispose(session);
  }, 20_000);

  test('keeps the pending next() across an idle timeout', async () => {
    let resolveNext: ((result: IteratorResult<FactoryEvent>) => void) | undefined;
    const source: PumpSource = {
      next: () =>
        new Promise<IteratorResult<FactoryEvent>>((resolve) => {
          resolveNext = resolve;
        }),
      respond: async () => undefined,
    };
    const state = emptyState();

    const idle = await pumpJobEvents(state, source, { waitMs: 20 });
    expect(idle.stopReason).toBe('idle');
    expect(idle.events).toEqual([]);
    expect(state.pendingNext).not.toBeNull();

    resolveNext?.({ done: true, value: undefined as never });
    const closed = await pumpJobEvents(state, source, { waitMs: 200 });
    expect(closed.stopReason).toBe('closed');
  }, 10_000);

  test('reports cancelled when the shutdown signal fires', async () => {
    const controller = new AbortController();
    const source: PumpSource = {
      next: () => new Promise<IteratorResult<FactoryEvent>>(() => undefined),
      respond: async () => undefined,
    };
    const state = emptyState();
    controller.abort();

    const result = await pumpJobEvents(state, source, {
      waitMs: 1_000,
      signal: controller.signal,
    });
    expect(result.stopReason).toBe('cancelled');
  });

  test('reports a stream failure as a terminal error instead of throwing', async () => {
    const source: PumpSource = {
      next: () => Promise.reject(new Error('harness stream broke')),
      respond: async () => undefined,
    };
    const state = emptyState();

    const result = await pumpJobEvents(state, source, { waitMs: 1_000 });
    expect(result.stopReason).toBe('terminal');
    expect(result.terminalStatus).toBe('error');
    expect(result.terminalSummary).toContain('harness stream broke');
  });
});

describe('runAgent', () => {
  test('enrolls, persists 0600 state, heartbeats and reports a command result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runner-agent-test-'));
    const stateFile = join(dir, 'state.json');

    const enrollBodies: Array<Record<string, unknown>> = [];
    const heartbeats: Array<Record<string, unknown>> = [];
    let commandResults = 0;
    let resultEnvelope: Record<string, unknown> | undefined;
    let resolveResult: (() => void) | undefined;
    const resultReceived = new Promise<void>((resolve) => {
      resolveResult = resolve;
    });
    let resolveHeartbeat: (() => void) | undefined;
    const firstHeartbeat = new Promise<void>((resolve) => {
      resolveHeartbeat = resolve;
    });

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const authorization = new Headers(init?.headers).get('authorization');

      if (url.endsWith('/api/v1/runner-agent/enroll') && method === 'POST') {
        enrollBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json(
          {
            hostId: 'host-1',
            agentToken: 'tok-1',
            heartbeatIntervalMs: 60_000,
            commandPollTimeoutMs: 5_000,
          },
          201,
        );
      }

      if (url.endsWith('/api/v1/runner-agent/heartbeat')) {
        expect(authorization).toBe('Bearer tok-1');
        heartbeats.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        resolveHeartbeat?.();
        return json({ ok: true });
      }

      if (url.includes('/api/v1/runner-agent/commands?waitMs=')) {
        expect(authorization).toBe('Bearer tok-1');
        commandResults += 1;
        if (commandResults === 1) {
          return json({
            command: {
              id: 'cmd-1',
              hostId: 'host-1',
              type: 'cancel',
              payload: { runId: 'unknown-run' },
              createdAt: new Date().toISOString(),
            },
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        return json({ command: null });
      }

      if (url.endsWith('/api/v1/runner-agent/commands/cmd-1/result')) {
        expect(authorization).toBe('Bearer tok-1');
        resultEnvelope = JSON.parse(String(init?.body)) as Record<string, unknown>;
        resolveResult?.();
        return json({ ok: true });
      }

      return json({ message: 'unexpected route' }, 404);
    }) as unknown as typeof fetch;

    const agent = await runAgent({
      apiUrl: 'https://api.test',
      enrollmentToken: 'enroll-token',
      stateFile,
      name: 'runner-a',
      platform: 'linux',
      arch: 'x64',
      pool: 'default',
      labels: { gpu: 'yes' },
      maxConcurrent: 2,
      agentVersion: '9.9.9',
      backend: 'local',
      heartbeatIntervalMs: 60_000,
      commandPollTimeoutMs: 5_000,
      env: {},
      fetchImpl,
    });

    try {
      await Promise.all([resultReceived, firstHeartbeat]);

      expect(enrollBodies).toHaveLength(1);
      expect(enrollBodies[0]).toMatchObject({
        token: 'enroll-token',
        name: 'runner-a',
        platform: 'linux',
        arch: 'x64',
        pool: 'default',
        labels: { gpu: 'yes' },
        maxConcurrent: 2,
        agentVersion: '9.9.9',
      });
      expect(typeof enrollBodies[0]?.hostname).toBe('string');

      expect(agent.hostId).toBe('host-1');
      expect(agent.agentToken).toBe('tok-1');

      const state = JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>;
      expect(state).toEqual({ hostId: 'host-1', agentToken: 'tok-1' });
      const mode = (await stat(stateFile)).mode & 0o777;
      expect(mode).toBe(0o600);

      expect(heartbeats.length).toBeGreaterThan(0);
      const metrics = heartbeats[0]?.metrics as Record<string, unknown>;
      expect(metrics.agentVersion).toBe('9.9.9');
      expect(typeof metrics.cpuPercent).toBe('number');
      expect(Array.isArray(metrics.disks)).toBe(true);
      expect(heartbeats[0]).toMatchObject({ status: 'ready', leases: 0 });

      expect(resultEnvelope).toMatchObject({ commandId: 'cmd-1', ok: true });
    } finally {
      await agent.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('reuses a stored agent token instead of enrolling again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runner-agent-state-'));
    const stateFile = join(dir, 'state.json');
    await writeFile(stateFile, JSON.stringify({ hostId: 'host-2', agentToken: 'tok-2' }));

    let enrollCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/enroll')) {
        enrollCalls += 1;
        return json({ message: 'should not enroll' }, 500);
      }
      if (url.includes('/heartbeat')) return json({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 25));
      return json({ command: null });
    }) as unknown as typeof fetch;

    const agent = await runAgent({
      apiUrl: 'https://api.test',
      stateFile,
      backend: 'local',
      heartbeatIntervalMs: 60_000,
      commandPollTimeoutMs: 5_000,
      env: {},
      fetchImpl,
    });

    try {
      expect(agent.hostId).toBe('host-2');
      expect(agent.agentToken).toBe('tok-2');
      expect(enrollCalls).toBe(0);
    } finally {
      await agent.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('resolveAgentConfig', () => {
  test('requires FACTORY_API_URL', () => {
    expect(() => resolveAgentConfig({}, {})).toThrow('FACTORY_API_URL');
  });

  test('fills documented defaults', () => {
    const config = resolveAgentConfig({}, { FACTORY_API_URL: 'https://factory.example.com' });
    expect(config.apiUrl).toBe('https://factory.example.com');
    expect(config.platform).toBe('linux');
    expect(config.pool).toBe('default');
    expect(config.backend).toBe('docker');
    expect(config.stateFile).toBe('.runner-agent.json');
    expect(config.maxConcurrent).toBe(1);
    expect(config.labels).toEqual({});
    expect(config.heartbeatIntervalMs).toBeUndefined();
    expect(config.commandPollTimeoutMs).toBeUndefined();
  });

  test('parses labels and rejects a bad platform', () => {
    const config = resolveAgentConfig(
      {},
      {
        FACTORY_API_URL: 'https://factory.example.com',
        RUNNER_LABELS: 'gpu=yes, arch=arm64, broken',
        RUNNER_MAX_CONCURRENT: '4',
        RUNNER_HEARTBEAT_INTERVAL_MS: '5000',
      },
    );
    expect(config.labels).toEqual({ gpu: 'yes', arch: 'arm64' });
    expect(config.maxConcurrent).toBe(4);
    expect(config.heartbeatIntervalMs).toBe(5000);

    expect(() =>
      resolveAgentConfig({}, { FACTORY_API_URL: 'https://x.test', RUNNER_PLATFORM: 'beos' }),
    ).toThrow('RUNNER_PLATFORM');
  });
});
