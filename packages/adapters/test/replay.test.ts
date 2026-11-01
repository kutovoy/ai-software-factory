import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ReplayAdapter,
  type FactoryEvent,
  type SessionHandle,
} from '../src';

/**
 * Recorded-run replay (spec `benchmark-replay`).
 *
 * A recording is `events.jsonl` + `patch.diff` in `runs/<runId>/`. The adapter re-emits the
 * canonical stream with a fresh envelope and applies the patch to a fresh workspace.
 */

const RECORDED: FactoryEvent[] = [
  { type: 'run.started', seq: 1, at: 1, runId: 'run_recorded', harness: 'opencode', model: 'm/x' },
  { type: 'message.delta', seq: 2, at: 2, role: 'assistant', text: 'Reading' },
  { type: 'message.completed', seq: 3, at: 3, role: 'assistant', text: 'Reading' },
  { type: 'tool.call.started', seq: 4, at: 4, callId: 'call_1', name: 'read_file', args: {} },
  {
    type: 'tool.call.completed',
    seq: 5,
    at: 5,
    callId: 'call_1',
    result: { ok: true },
    ok: true,
  },
  { type: 'file.edited', seq: 6, at: 6, path: 'README.md', diff: '@@ -1 +1 @@' },
  {
    type: 'usage.updated',
    seq: 7,
    at: 7,
    inputTokens: 1200,
    outputTokens: 80,
    costUsd: 0.0021,
  },
  { type: 'run.completed', seq: 8, at: 8, status: 'ok' },
];

const PATCH = [
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-# Factory',
  '+# Factory replayed',
  '',
].join('\n');

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function recording(events: FactoryEvent[] = RECORDED, patch = PATCH): Promise<string> {
  const dir = await tempDir('factory-replay-recording-');
  await writeFile(join(dir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  await writeFile(join(dir, 'patch.diff'), patch, 'utf8');
  return dir;
}

async function workspace(): Promise<string> {
  const dir = await tempDir('factory-replay-workspace-');
  await writeFile(join(dir, 'README.md'), '# Factory\n', 'utf8');
  spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function collect(
  adapter: ReplayAdapter,
  handle: SessionHandle,
): Promise<FactoryEvent[]> {
  const events: FactoryEvent[] = [];
  for await (const event of adapter.streamEvents(handle)) events.push(event);
  return events;
}

describe('ReplayAdapter', () => {
  test('re-emits the recorded stream with a fresh envelope and the new run id', async () => {
    const dir = await recording();
    const adapter = new ReplayAdapter({ recordingDir: dir, clock: () => 1_000 });
    const handle = await adapter.startSession({ runId: 'run_replay_1' });

    expect(handle.adapterId).toBe('replay');
    expect(handle.sessionRef).toBe('replay-run_replay_1');

    const events = await collect(adapter, handle);
    expect(events.map((event) => event.type)).toEqual(RECORDED.map((event) => event.type));
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(events.every((event) => event.at === 1_000)).toBe(true);

    const started = events[0] as Extract<FactoryEvent, { type: 'run.started' }>;
    expect(started.runId).toBe('run_replay_1');
    expect(started.harness).toBe('replay');
    expect(started.model).toBe('m/x');
  });

  test('applies the recorded patch to a fresh workspace', async () => {
    const dir = await recording();
    const target = await workspace();
    const adapter = new ReplayAdapter({ recordingDir: dir, workspace: target });
    const handle = await adapter.startSession({ runId: 'run_replay_2' });

    expect((await readFile(join(target, 'README.md'), 'utf8')).trim()).toBe('# Factory replayed');

    const diff = await adapter.getDiff(handle);
    expect(diff).toHaveLength(1);
    expect(diff[0]?.path).toBe('patch.diff');
    expect(diff[0]?.diff).toContain('+# Factory replayed');
  });

  test('reports usage from the recording with zero cost (no model call)', async () => {
    const dir = await recording();
    const adapter = new ReplayAdapter({ recordingDir: dir });
    const handle = await adapter.startSession({ runId: 'run_replay_3' });

    expect(await adapter.getUsage(handle)).toMatchObject({
      inputTokens: 1200,
      outputTokens: 80,
      costUsd: 0,
    });
  });

  test('a recording without a terminal event still ends the run', async () => {
    const dir = await recording(RECORDED.filter((event) => event.type !== 'run.completed'));
    const adapter = new ReplayAdapter({ recordingDir: dir });
    const handle = await adapter.startSession({ runId: 'run_replay_4' });

    const events = await collect(adapter, handle);
    const last = events.at(-1);
    expect(last?.type).toBe('run.completed');
    expect(last).toMatchObject({ status: 'ok' });
  });

  test('a missing recording fails with replay_missing', async () => {
    const dir = await tempDir('factory-replay-missing-');
    const adapter = new ReplayAdapter({ recordingDir: dir });
    await expect(adapter.startSession({ runId: 'run_replay_5' })).rejects.toMatchObject({
      code: 'replay_missing',
      details: { events: false, patch: false },
    });
  });

  test('a missing patch fails with replay_missing', async () => {
    const dir = await tempDir('factory-replay-no-patch-');
    await writeFile(join(dir, 'events.jsonl'), `${JSON.stringify(RECORDED[0])}\n`, 'utf8');
    const adapter = new ReplayAdapter({ recordingDir: dir });
    await expect(adapter.startSession({ runId: 'run_replay_6' })).rejects.toMatchObject({
      code: 'replay_missing',
      details: { events: true, patch: false },
    });
  });

  test('a patch that does not apply fails with replay_apply_failed', async () => {
    const dir = await recording(RECORDED, PATCH);
    const target = await tempDir('factory-replay-bad-workspace-');
    // No README.md: `git apply` cannot find the file the patch expects.
    const adapter = new ReplayAdapter({ recordingDir: dir, workspace: target });
    await expect(adapter.startSession({ runId: 'run_replay_7' })).rejects.toMatchObject({
      code: 'replay_apply_failed',
    });
  });

  test('a malformed event line fails with invalid_response', async () => {
    const dir = await tempDir('factory-replay-invalid-');
    await writeFile(join(dir, 'events.jsonl'), '{not json}\n', 'utf8');
    await writeFile(join(dir, 'patch.diff'), PATCH, 'utf8');
    const adapter = new ReplayAdapter({ recordingDir: dir });
    await expect(adapter.startSession({ runId: 'run_replay_8' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
