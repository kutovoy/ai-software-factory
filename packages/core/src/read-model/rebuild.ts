import type { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Read-model rebuild (harden-runtime, task 3, ADR-024).
 *
 * The canonical `runs/<runId>/events.jsonl` log is the source of truth; Postgres is a
 * projection. `factory rebuild` replays every log in `(runId, seq)` order and upserts the
 * derived run/step/event rows idempotently. It never deletes a row it cannot explain: rows
 * that exist in Postgres but not in the log are reported as `orphaned` and kept.
 *
 * The log does not carry the run's factory or definition commit (those are Temporal/API
 * inputs, not harness events), so a run row that must be inserted derives them from the
 * linked work item when the id encodes one, and otherwise records `unknown` rather than
 * inventing a value. Coarse steps are only reconstructable at the boundaries the workflow
 * always writes (`persist-run`, `finish-run`); other step rows are reported, never removed.
 */

export type TerminalStatus = 'ok' | 'error' | 'cancelled';

export interface LogEvent {
  seq: number;
  type: string;
  at: number;
  payload: Record<string, unknown>;
}

export interface LogRun {
  runId: string;
  path: string;
  events: LogEvent[];
  harness: string | null;
  model: string | null;
  startedAt: number;
  endedAt: number | null;
  status: 'pending' | 'running' | TerminalStatus;
  terminalStatus: TerminalStatus | null;
  summary: string | null;
  error: string | null;
}

export type CorruptReason = 'gap' | 'duplicate' | 'invalid';

export interface CorruptLog {
  runId: string;
  seq: number;
  reason: CorruptReason;
  detail: string;
}

export class EventLogCorruptError extends Error {
  readonly code = 'event_log_corrupt';
  readonly logs: CorruptLog[];

  constructor(logs: CorruptLog[]) {
    super(
      `event log is corrupt: ${logs
        .map((log) => `${log.runId} seq ${log.seq} (${log.reason})`)
        .join(', ')}`,
    );
    this.name = 'EventLogCorruptError';
    this.logs = logs;
  }
}

const SKIPPED_DIRS = new Set(['canary', 'experience', 'deploy']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Reads every `events.jsonl` under `runsDir` and validates the sequence: it must start at
 * 1 and be strictly contiguous (a gap or a duplicate is `event_log_corrupt`).
 */
export async function readEventLogs(
  runsDir: string,
  options: { runId?: string } = {},
): Promise<{ runs: LogRun[]; corrupt: CorruptLog[] }> {
  const entries = await readdir(runsDir, { withFileTypes: true });
  const runDirs = entries
    .filter((entry) => entry.isDirectory() && !SKIPPED_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .filter((name) => (options.runId ? name === options.runId : true))
    .sort();

  const runs: LogRun[] = [];
  const corrupt: CorruptLog[] = [];

  for (const dir of runDirs) {
    const path = join(runsDir, dir, 'events.jsonl');
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue; // no event log (an artifact-only directory)
    }

    const lines = text.split('\n').filter((line) => line.trim() !== '');
    const events: LogEvent[] = [];
    let runId = dir;
    let expected = 1;
    let invalid = false;

    for (const [index, line] of lines.entries()) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (error) {
        corrupt.push({
          runId,
          seq: index + 1,
          reason: 'invalid',
          detail: `line ${index + 1} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        });
        invalid = true;
        break;
      }
      const record = asRecord(raw);
      const seq = record.seq;
      const at = record.at;
      const type = record.type;
      if (
        typeof seq !== 'number' ||
        !Number.isInteger(seq) ||
        seq < 1 ||
        typeof at !== 'number' ||
        typeof type !== 'string'
      ) {
        corrupt.push({
          runId,
          seq: typeof seq === 'number' ? seq : index + 1,
          reason: 'invalid',
          detail: 'event needs an integer seq, a numeric at and a string type',
        });
        invalid = true;
        break;
      }
      if (typeof record.runId === 'string' && record.runId.length > 0) runId = record.runId;

      if (seq === expected - 1) {
        corrupt.push({
          runId,
          seq,
          reason: 'duplicate',
          detail: `seq ${seq} appears more than once`,
        });
        invalid = true;
        break;
      }
      if (seq !== expected) {
        corrupt.push({
          runId,
          seq,
          reason: 'gap',
          detail: `expected seq ${expected}, found ${seq}`,
        });
        invalid = true;
        break;
      }
      expected += 1;

      events.push({ seq, type, at, payload: record });
    }

    if (invalid) continue;
    if (events.length === 0) {
      corrupt.push({
        runId,
        seq: 1,
        reason: 'gap',
        detail: 'the event log is empty',
      });
      continue;
    }

    const first = events[0] as LogEvent;
    const last = events[events.length - 1] as LogEvent;
    const started = events.find((event) => event.type === 'run.started');
    const terminal = [...events].reverse().find((event) => event.type === 'run.completed');
    const terminalStatus =
      terminal && typeof terminal.payload.status === 'string'
        ? (terminal.payload.status as TerminalStatus)
        : null;

    runs.push({
      runId,
      path,
      events,
      harness: started ? stringOrNull(started.payload.harness) : null,
      model: started ? stringOrNull(started.payload.model) : null,
      startedAt: first.at,
      endedAt: terminal ? terminal.at : null,
      status: terminalStatus ?? 'running',
      terminalStatus,
      summary: terminal ? stringOrNull(terminal.payload.summary) : null,
      error:
        terminal && terminalStatus !== 'ok' ? stringOrNull(terminal.payload.summary) : null,
    });
  }

  return { runs, corrupt };
}

/* --------------------------------------------------------------- planning */

export interface ExistingRun {
  id: string;
  status: string;
  harness: string;
  model: string | null;
  summary: string | null;
  error: string | null;
}

export interface ExistingStep {
  run_id: string;
  step_id: string;
  status: string;
}

export interface ExistingEvent {
  run_id: string;
  seq: number;
  type: string;
  ts: number | string;
  payload: unknown;
}

export interface RebuildSource {
  runs: LogRun[];
  existingRuns: ExistingRun[];
  existingSteps: ExistingStep[];
  existingEvents: ExistingEvent[];
}

export interface RunUpsert {
  runId: string;
  insert: boolean;
  status: string;
  harness: string | null;
  model: string | null;
  summary: string | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface StepUpsert {
  runId: string;
  stepId: string;
  kind: string;
  status: string;
  detail: Record<string, unknown>;
  startedAt: number;
  endedAt: number | null;
}

export interface EventUpsert {
  runId: string;
  seq: number;
  type: string;
  ts: number;
  payload: Record<string, unknown>;
}

export interface RebuildDiff {
  /** Present in the log, missing from the projection. */
  missing: { runs: string[]; steps: string[]; events: string[] };
  /** Present in both, but the projection disagrees with the log. */
  divergent: { runs: string[]; steps: string[]; events: string[] };
  /** Present in the projection but not in the log: reported, never deleted. */
  orphaned: { runs: string[]; steps: string[]; events: string[] };
  /** Logs that cannot be replayed (gap / duplicate / invalid). */
  corrupt: CorruptLog[];
}

export interface RebuildPlan {
  runs: RunUpsert[];
  steps: StepUpsert[];
  events: EventUpsert[];
  diff: RebuildDiff;
}

function stepKey(runId: string, stepId: string): string {
  return `${runId}/${stepId}`;
}

function eventKey(runId: string, seq: number): string {
  return `${runId}#${seq}`;
}

/** jsonb reorders object keys; compare semantically, not by insertion order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Pure planner: compares the replayed logs with the current projection and returns the
 * upserts plus the diff. Deterministic and side-effect free, so the tests (and a dry run)
 * exercise exactly the same logic the writer uses.
 */
export function planRebuild(source: RebuildSource): RebuildPlan {
  const diff: RebuildDiff = {
    missing: { runs: [], steps: [], events: [] },
    divergent: { runs: [], steps: [], events: [] },
    orphaned: { runs: [], steps: [], events: [] },
    corrupt: [],
  };

  const existingRuns = new Map(source.existingRuns.map((row) => [row.id, row]));
  const existingSteps = new Map(
    source.existingSteps.map((row) => [stepKey(row.run_id, row.step_id), row]),
  );
  const existingEvents = new Map(
    source.existingEvents.map((row) => [eventKey(row.run_id, Number(row.seq)), row]),
  );

  const runs: RunUpsert[] = [];
  const steps: StepUpsert[] = [];
  const events: EventUpsert[] = [];
  const seenRuns = new Set<string>();
  const seenSteps = new Set<string>();
  const seenEvents = new Set<string>();

  for (const run of [...source.runs].sort((a, b) => a.runId.localeCompare(b.runId))) {
    seenRuns.add(run.runId);
    const existing = existingRuns.get(run.runId);
    if (!existing) diff.missing.runs.push(run.runId);

    const divergentFields: string[] = [];
    if (existing) {
      if (existing.status !== run.status) divergentFields.push('status');
      if (existing.harness !== (run.harness ?? existing.harness)) divergentFields.push('harness');
      if (run.model !== null && existing.model !== run.model) divergentFields.push('model');
      if ((run.summary ?? null) !== (existing.summary ?? null)) divergentFields.push('summary');
      if ((run.error ?? null) !== (existing.error ?? null)) divergentFields.push('error');
      if (divergentFields.length > 0) diff.divergent.runs.push(run.runId);
    }

    runs.push({
      runId: run.runId,
      insert: !existing,
      status: run.status,
      harness: run.harness,
      model: run.model,
      summary: run.summary,
      error: run.error,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    });

    // Boundary steps the workflow always writes; they are derivable from the log.
    const first = run.events[0] as LogEvent;
    const persistStepId = 'persist-run';
    const persistKey = stepKey(run.runId, persistStepId);
    seenSteps.add(persistKey);
    const existingPersist = existingSteps.get(persistKey);
    if (!existingPersist) diff.missing.steps.push(persistKey);
    else if (existingPersist.status !== 'ok') diff.divergent.steps.push(persistKey);
    steps.push({
      runId: run.runId,
      stepId: persistStepId,
      kind: 'persist',
      status: 'ok',
      detail: {
        factory: 'unknown',
        definitionCommit: 'unknown',
        harness: run.harness,
        runner: run.harness === 'fake' ? 'fake' : 'unknown',
        rebuilt: true,
      },
      startedAt: first.at,
      endedAt: first.at,
    });

    if (run.terminalStatus) {
      const finishStepId = 'finish-run';
      const finishKey = stepKey(run.runId, finishStepId);
      seenSteps.add(finishKey);
      const status =
        run.terminalStatus === 'ok'
          ? 'ok'
          : run.terminalStatus === 'cancelled'
            ? 'cancelled'
            : 'error';
      const existingFinish = existingSteps.get(finishKey);
      if (!existingFinish) diff.missing.steps.push(finishKey);
      else if (existingFinish.status !== status) diff.divergent.steps.push(finishKey);
      steps.push({
        runId: run.runId,
        stepId: finishStepId,
        kind: 'persist',
        status,
        detail: { status: run.terminalStatus, summary: run.summary, rebuilt: true },
        startedAt: run.endedAt ?? first.at,
        endedAt: run.endedAt ?? first.at,
      });
    }

    for (const event of run.events) {
      const key = eventKey(run.runId, event.seq);
      seenEvents.add(key);
      const existingEvent = existingEvents.get(key);
      if (!existingEvent) diff.missing.events.push(key);
      else if (
        existingEvent.type !== event.type ||
        Number(existingEvent.ts) !== event.at ||
        stableJson(existingEvent.payload) !== stableJson(event.payload)
      ) {
        diff.divergent.events.push(key);
      }
      events.push({
        runId: run.runId,
        seq: event.seq,
        type: event.type,
        ts: event.at,
        payload: event.payload,
      });
    }
  }

  // Rows the log cannot explain: reported as orphaned, never deleted.
  for (const row of source.existingRuns) {
    if (!seenRuns.has(row.id)) diff.orphaned.runs.push(row.id);
  }
  for (const row of source.existingSteps) {
    if (!seenSteps.has(stepKey(row.run_id, row.step_id))) {
      diff.orphaned.steps.push(stepKey(row.run_id, row.step_id));
    }
  }
  for (const row of source.existingEvents) {
    if (!seenEvents.has(eventKey(row.run_id, Number(row.seq)))) {
      diff.orphaned.events.push(eventKey(row.run_id, Number(row.seq)));
    }
  }

  return { runs, steps, events, diff };
}

/* ---------------------------------------------------------------- replay */

export interface RebuildOptions {
  runsDir: string;
  dryRun?: boolean;
  /** Replay one run only (diagnostics). */
  runId?: string;
}

export interface RebuildReport {
  dryRun: boolean;
  scanned: { runs: number; events: number };
  written: { runs: number; steps: number; events: number };
  diff: RebuildDiff;
}

export interface RebuildRunContext {
  factory: string;
  definitionCommit: string;
}

/**
 * Work item ids are `wi_<ulid>`; stage runs embed that ULID (`run_<ulid>_<stage>_<n>`), so
 * a rebuilt run row can inherit the factory/commit it actually ran.
 */
export function workItemIdForRun(runId: string): string | null {
  const match = /^run_([0-9A-HJKMNP-TV-Z]{26})(?:_|$)/.exec(runId);
  return match ? `wi_${match[1]}` : null;
}

export async function rebuildReadModel(
  sql: SQL,
  options: RebuildOptions,
): Promise<RebuildReport> {
  const { runs, corrupt } = await readEventLogs(options.runsDir, {
    ...(options.runId ? { runId: options.runId } : {}),
  });
  if (corrupt.length > 0) throw new EventLogCorruptError(corrupt);

  const scopedRunId = options.runId ?? null;
  const existingRuns = (await sql`
    select id, status, harness, model, summary, error from runs
    where (${scopedRunId}::text is null or id = ${scopedRunId})
  `) as ExistingRun[];
  const existingSteps = (await sql`
    select run_id, step_id, status from run_steps
    where (${scopedRunId}::text is null or run_id = ${scopedRunId})
  `) as ExistingStep[];
  const existingEvents = (await sql`
    select run_id, seq, type, ts, payload from events
    where (${scopedRunId}::text is null or run_id = ${scopedRunId})
  `) as ExistingEvent[];

  const plan = planRebuild({ runs, existingRuns, existingSteps, existingEvents });
  const report: RebuildReport = {
    dryRun: options.dryRun === true,
    scanned: { runs: runs.length, events: runs.reduce((sum, run) => sum + run.events.length, 0) },
    written: { runs: 0, steps: 0, events: 0 },
    diff: plan.diff,
  };
  if (options.dryRun === true) return report;

  const contexts = new Map<string, RebuildRunContext>();
  const workItemIds = runs
    .map((run) => workItemIdForRun(run.runId))
    .filter((id): id is string => id !== null);
  for (const workItemId of new Set(workItemIds)) {
    const rows = (await sql`
      select id, factory, definition_commit from work_items where id = ${workItemId} limit 1
    `) as { id: string; factory: string; definition_commit: string }[];
    const row = rows[0];
    if (row) contexts.set(row.id, { factory: row.factory, definitionCommit: row.definition_commit });
  }

  const changedRuns = new Set([...plan.diff.missing.runs, ...plan.diff.divergent.runs]);
  const changedSteps = new Set([...plan.diff.missing.steps, ...plan.diff.divergent.steps]);
  const changedEvents = new Set([...plan.diff.missing.events, ...plan.diff.divergent.events]);

  for (const upsert of plan.runs) {
    if (!changedRuns.has(upsert.runId)) continue;
    const workItemId = workItemIdForRun(upsert.runId);
    const context = workItemId ? contexts.get(workItemId) : undefined;
    if (upsert.insert) {
      await sql`
        insert into runs (
          id, factory, definition_commit, definition_dirty, harness, model, runner, kind,
          title, input, status, workflow_id, started_at, ended_at, summary, error
        ) values (
          ${upsert.runId}, ${context?.factory ?? 'unknown'},
          ${context?.definitionCommit ?? 'unknown'}, false,
          ${upsert.harness ?? 'unknown'}, ${upsert.model},
          ${upsert.harness === 'fake' ? 'fake' : 'unknown'}, 'run', null, ${{ rebuilt: true }}::jsonb,
          ${upsert.status}, ${`run-${upsert.runId}`},
          ${new Date(upsert.startedAt)}, ${upsert.endedAt === null ? null : new Date(upsert.endedAt)},
          ${upsert.summary}, ${upsert.error}
        )
        on conflict (id) do nothing
      `;
      report.written.runs += 1;
    } else {
      await sql`
        update runs set
          status = ${upsert.status},
          ended_at = coalesce(${upsert.endedAt === null ? null : new Date(upsert.endedAt)}::timestamptz, ended_at),
          summary = ${upsert.summary},
          error = ${upsert.error},
          harness = coalesce(${upsert.harness}::text, harness),
          model = coalesce(${upsert.model}::text, model)
        where id = ${upsert.runId}
      `;
      report.written.runs += 1;
    }
  }

  for (const step of plan.steps) {
    if (!changedSteps.has(stepKey(step.runId, step.stepId))) continue;
    await sql`
      insert into run_steps (run_id, step_id, kind, status, detail, started_at, ended_at)
      values (
        ${step.runId}, ${step.stepId}, ${step.kind}, ${step.status}, ${step.detail}::jsonb,
        ${new Date(step.startedAt)}, ${step.endedAt === null ? null : new Date(step.endedAt)}
      )
      on conflict (run_id, step_id) do update set
        status = excluded.status,
        detail = excluded.detail,
        ended_at = excluded.ended_at
    `;
    report.written.steps += 1;
  }

  for (const event of plan.events) {
    if (!changedEvents.has(eventKey(event.runId, event.seq))) continue;
    await sql`
      insert into events (run_id, seq, type, ts, payload, step_id)
      values (${event.runId}, ${event.seq}, ${event.type}, ${event.ts}, ${event.payload}::jsonb, null)
      on conflict (run_id, seq) do update set
        type = excluded.type,
        ts = excluded.ts,
        payload = excluded.payload
    `;
    report.written.events += 1;
  }

  return report;
}
