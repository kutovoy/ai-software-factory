import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQL } from 'bun';
import {
  EventLogCorruptError,
  planRebuild,
  readEventLogs,
  rebuildReadModel,
  workItemIdForRun,
  type ExistingEvent,
  type ExistingRun,
  type ExistingStep,
  type LogEvent,
} from '../src/index';

/**
 * Read-model rebuild (harden-runtime, task 3.4): replay is pure enough to test without a
 * database. The planner is the same code the writer applies, so these tests cover the
 * clean rebuild, the second-run no-op, orphan reporting and corrupt-log refusal.
 */

const dirs: string[] = [];

async function runsDirWith(runs: Record<string, LogEvent[]>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factory-rebuild-'));
  dirs.push(dir);
  for (const [runId, events] of Object.entries(runs)) {
    await mkdir(join(dir, runId), { recursive: true });
    await writeFile(
      join(dir, runId, 'events.jsonl'),
      `${events.map((entry) => JSON.stringify(entry.payload)).join('\n')}\n`,
      'utf8',
    );
  }
  return dir;
}

function event(seq: number, type: string, extra: Record<string, unknown> = {}): LogEvent {
  return { seq, type, at: 1_700_000_000_000 + seq * 1000, payload: { seq, type, at: 1_700_000_000_000 + seq * 1000, ...extra } };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('event log replay', () => {
  it('reads a clean log in (runId, seq) order', async () => {
    const dir = await runsDirWith({
      run_b: [event(1, 'run.started', { harness: 'fake' }), event(2, 'run.completed', { status: 'ok' })],
      run_a: [event(1, 'run.started', { harness: 'fake' }), event(2, 'run.completed', { status: 'cancelled' })],
    });
    const { runs, corrupt } = await readEventLogs(dir);
    expect(corrupt).toEqual([]);
    expect(runs.map((run) => run.runId)).toEqual(['run_a', 'run_b']);
    expect(runs[0]?.status).toBe('cancelled');
    expect(runs[1]?.status).toBe('ok');
    expect(runs[0]?.events.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it('refuses a gap in the sequence', async () => {
    const dir = await runsDirWith({ run_gap: [event(1, 'run.started'), event(3, 'run.completed')] });
    const { corrupt } = await readEventLogs(dir);
    expect(corrupt).toEqual([
      { runId: 'run_gap', seq: 3, reason: 'gap', detail: 'expected seq 2, found 3' },
    ]);
    await expect(
      rebuildReadModel({} as SQL, { runsDir: dir, dryRun: true }),
    ).rejects.toBeInstanceOf(EventLogCorruptError);
  });

  it('refuses a duplicate seq', async () => {
    const dir = await runsDirWith({ run_dup: [event(1, 'run.started'), event(2, 'message.delta'), event(2, 'run.completed')] });
    const { corrupt } = await readEventLogs(dir);
    expect(corrupt[0]).toMatchObject({ runId: 'run_dup', seq: 2, reason: 'duplicate' });
  });

  it('refuses a log that does not start at seq 1', async () => {
    const dir = await runsDirWith({ run_late: [event(2, 'run.started')] });
    const { corrupt } = await readEventLogs(dir);
    expect(corrupt[0]).toMatchObject({ runId: 'run_late', seq: 2, reason: 'gap' });
  });
});

describe('rebuild plan', () => {
  const logs = [
    {
      runId: 'run_a',
      path: '/runs/run_a/events.jsonl',
      events: [event(1, 'run.started', { harness: 'fake' }), event(2, 'run.completed', { status: 'ok', summary: 'done' })],
      harness: 'fake',
      model: null,
      startedAt: 1_700_000_001_000,
      endedAt: 1_700_000_002_000,
      status: 'ok' as const,
      terminalStatus: 'ok' as const,
      summary: 'done',
      error: null,
    },
  ];

  const empty = { existingRuns: [] as ExistingRun[], existingSteps: [] as ExistingStep[], existingEvents: [] as ExistingEvent[] };

  it('plans every row as missing on a clean rebuild', () => {
    const plan = planRebuild({ runs: logs, ...empty });
    expect(plan.diff.missing.runs).toEqual(['run_a']);
    expect(plan.diff.missing.steps).toEqual(['run_a/persist-run', 'run_a/finish-run']);
    expect(plan.diff.missing.events).toEqual(['run_a#1', 'run_a#2']);
    expect(plan.diff.orphaned).toEqual({ runs: [], steps: [], events: [] });
    expect(plan.runs[0]?.insert).toBe(true);
    expect(plan.events.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it('is a no-op when the projection already matches the log', () => {
    const first = planRebuild({ runs: logs, ...empty });
    const existingRuns: ExistingRun[] = first.runs.map((row) => ({
      id: row.runId,
      status: row.status,
      harness: row.harness ?? 'unknown',
      model: row.model,
      summary: row.summary,
      error: row.error,
    }));
    const existingSteps: ExistingStep[] = first.steps.map((row) => ({
      run_id: row.runId,
      step_id: row.stepId,
      status: row.status,
    }));
    const existingEvents: ExistingEvent[] = first.events.map((row) => ({
      run_id: row.runId,
      seq: row.seq,
      type: row.type,
      ts: row.ts,
      payload: row.payload,
    }));

    const second = planRebuild({
      runs: logs,
      existingRuns,
      existingSteps,
      existingEvents,
    });
    expect(second.diff.missing).toEqual({ runs: [], steps: [], events: [] });
    expect(second.diff.divergent).toEqual({ runs: [], steps: [], events: [] });
    expect(second.diff.orphaned).toEqual({ runs: [], steps: [], events: [] });
    expect(second.runs[0]?.insert).toBe(false);
  });

  it('does not report a divergent event when jsonb only reordered the keys', () => {
    const first = planRebuild({ runs: logs, ...empty });
    // jsonb stores keys sorted; the JSONL preserves insertion order. Both are the same value.
    const reordered = first.events.map((row) => ({
      run_id: row.runId,
      seq: row.seq,
      type: row.type,
      ts: row.ts,
      payload: Object.fromEntries(Object.entries(row.payload).reverse()),
    }));
    const second = planRebuild({
      runs: logs,
      existingRuns: first.runs.map((row) => ({
        id: row.runId,
        status: row.status,
        harness: row.harness ?? 'unknown',
        model: row.model,
        summary: row.summary,
        error: row.error,
      })),
      existingSteps: first.steps.map((row) => ({
        run_id: row.runId,
        step_id: row.stepId,
        status: row.status,
      })),
      existingEvents: reordered,
    });
    expect(second.diff.divergent.events).toEqual([]);
  });

  it('reports a divergent row instead of silently accepting it', () => {
    const plan = planRebuild({
      runs: logs,
      existingRuns: [
        { id: 'run_a', status: 'error', harness: 'fake', model: null, summary: 'done', error: null },
      ],
      existingSteps: [],
      existingEvents: [],
    });
    expect(plan.diff.divergent.runs).toEqual(['run_a']);
  });

  it('reports an orphaned row and never deletes it', () => {
    const plan = planRebuild({
      runs: logs,
      existingRuns: [
        { id: 'run_a', status: 'ok', harness: 'fake', model: null, summary: 'done', error: null },
        { id: 'run_deleted', status: 'ok', harness: 'fake', model: null, summary: null, error: null },
      ],
      existingSteps: [{ run_id: 'run_deleted', step_id: 'lease-runner', status: 'ok' }],
      existingEvents: [{ run_id: 'run_deleted', seq: 1, type: 'run.started', ts: 1, payload: {} }],
    });
    expect(plan.diff.orphaned.runs).toEqual(['run_deleted']);
    expect(plan.diff.orphaned.steps).toEqual(['run_deleted/lease-runner']);
    expect(plan.diff.orphaned.events).toEqual(['run_deleted#1']);
    expect(plan.runs.some((row) => row.runId === 'run_deleted')).toBe(false);
  });

  it('maps a stage run id to its work item', () => {
    expect(workItemIdForRun('run_01M64N0YV01EVF4FDS9Z5BX5ZE_triage_1')).toBe(
      'wi_01M64N0YV01EVF4FDS9Z5BX5ZE',
    );
    expect(workItemIdForRun('run_01M64N0YV01EVF4FDS9Z5BX5ZE')).toBe(
      'wi_01M64N0YV01EVF4FDS9Z5BX5ZE',
    );
    expect(workItemIdForRun('run_short')).toBeNull();
  });
});
