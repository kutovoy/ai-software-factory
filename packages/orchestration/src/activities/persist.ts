import { appendFile } from 'node:fs/promises';
import { ApplicationFailure } from '@temporalio/activity';
import { parseFactoryEvent, type FactoryEvent } from '@factory/adapters';
import {
  finishRun,
  getSql,
  hasTerminalEvent,
  listEvents,
  markRunRunning,
  upsertPermissionRequest,
  upsertStep,
} from '../db';
import { loadConfig } from '../config';
import { heartbeat } from '../heartbeat';
import { ensureRunDir, eventsPath } from '../run-dir';
import type {
  AppendTerminalInput,
  AppendTerminalResult,
  PersistEventInput,
  RunInput,
  StepRecord,
  TerminalStatus,
} from '../types';

/**
 * Persistence activities — the single writer for a run's event log.
 *
 * Idempotency: every write is keyed by `runId + stepId` (ADR-010). Event writes are
 * additionally keyed by `(run_id, seq)` and guarded by a per-run advisory lock, so a
 * retried activity (Temporal is at-least-once) never appends a duplicate JSONL line or
 * a duplicate row. Sequence numbers come from the adapter's single sequencer, so the
 * JSONL log and the Postgres index always agree.
 *
 * Retry policy lives in the workflow (`proxyActivities`); these functions are safe to
 * call any number of times.
 */

async function lockRun(runId: string): Promise<void> {
  const sql = getSql();
  await sql`select pg_advisory_xact_lock(hashtext(${runId}))`;
}

async function appendJsonl(runId: string, event: FactoryEvent): Promise<void> {
  const config = loadConfig();
  await ensureRunDir(config.runsDir, runId);
  await appendFile(eventsPath(config.runsDir, runId), `${JSON.stringify(event)}\n`, 'utf8');
}

export async function persistRun(args: { input: RunInput; workflowId: string }): Promise<void> {
  const config = loadConfig();
  await ensureRunDir(config.runsDir, args.input.runId);
  await markRunRunning(args.input, args.workflowId);
  await upsertStep({
    runId: args.input.runId,
    stepId: 'persist-run',
    kind: 'persist',
    status: 'ok',
    detail: {
      factory: args.input.factory,
      definitionCommit: args.input.definitionCommit,
      harness: args.input.harness,
      runner: args.input.runner,
      workflowId: args.workflowId,
    },
  });
}

export async function persistStep(step: StepRecord): Promise<void> {
  await upsertStep(step);
}

/** Appends one canonical adapter event. Returns `appended: false` on a retry. */
export async function appendEvent(
  args: PersistEventInput,
): Promise<{ appended: boolean; seq: number | null }> {
  const event = parseFactoryEvent(args.event);
  if (!event) {
    throw ApplicationFailure.create({
      type: 'invalid_event',
      nonRetryable: true,
      message: `run ${args.runId} step ${args.stepId}: adapter produced a non-canonical event`,
    });
  }

  const result = await getSql().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${args.runId}))`;
    const inserted = (await tx`
      insert into events (run_id, seq, type, ts, payload, step_id)
      values (${args.runId}, ${event.seq}, ${event.type}, ${event.at},
              ${JSON.stringify(event)}::jsonb, ${args.stepId})
      on conflict (run_id, seq) do nothing
      returning seq
    `) as { seq: number }[];
    if (inserted.length === 0) return { appended: false, seq: null };

    if (event.type === 'usage.updated') {
      await tx`
        update runs set
          input_tokens = ${event.inputTokens},
          output_tokens = ${event.outputTokens},
          cost_usd = coalesce(${event.costUsd ?? null}, cost_usd)
        where id = ${args.runId}
      `;
    }

    await appendJsonl(args.runId, event);
    return { appended: true, seq: event.seq };
  });

  // Heartbeat so the pump activity's heartbeat timeout is not tripped by a slow write.
  heartbeat({ lastSeq: result.seq ?? undefined });
  return result;
}

/**
 * Writes the one and only `run.completed` event if the adapter did not emit one.
 * Enforces the spec rule "exactly one terminal event per run".
 */
export async function appendTerminalEvent(
  args: AppendTerminalInput,
): Promise<AppendTerminalResult> {
  const result = await getSql().begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${args.runId}))`;

    const existing = (await tx`
      select seq from events where run_id = ${args.runId} and type = 'run.completed' limit 1
    `) as { seq: number }[];
    if (existing.length > 0) return { appended: false, seq: existing[0].seq };

    const next = (await tx`
      select coalesce(max(seq), 0) + 1 as seq from events where run_id = ${args.runId}
    `) as { seq: number | string }[];
    const seq = Number(next[0]?.seq ?? 1);

    const event: FactoryEvent = {
      type: 'run.completed',
      seq,
      at: Date.now(),
      status: args.status,
      ...(args.summary ? { summary: args.summary } : {}),
    };

    await tx`
      insert into events (run_id, seq, type, ts, payload, step_id)
      values (${args.runId}, ${event.seq}, ${event.type}, ${event.at},
              ${JSON.stringify(event)}::jsonb, ${args.stepId})
      on conflict (run_id, seq) do nothing
    `;
    await appendJsonl(args.runId, event);
    return { appended: true, seq };
  });

  heartbeat({ lastSeq: result.seq ?? undefined });
  return result;
}

export async function finishRunActivity(args: {
  runId: string;
  status: TerminalStatus;
  summary?: string | null;
  error?: string | null;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  artifacts?: unknown;
}): Promise<void> {
  await finishRun(args);
  await upsertStep({
    runId: args.runId,
    stepId: 'finish-run',
    kind: 'persist',
    status: args.status === 'ok' ? 'ok' : args.status === 'cancelled' ? 'cancelled' : 'error',
    detail: { status: args.status, summary: args.summary ?? null },
    error: args.error ?? null,
  });
}

export async function readTerminalState(args: {
  runId: string;
}): Promise<{ hasTerminal: boolean; lastSeq: number }> {
  const events = await listEvents(args.runId, 0, 10_000);
  const lastSeq = events.length > 0 ? Number(events[events.length - 1].seq) : 0;
  return { hasTerminal: await hasTerminalEvent(args.runId), lastSeq };
}

export async function recordPermissionRequest(args: {
  runId: string;
  requestId: string;
  action: string;
  detail: unknown;
}): Promise<void> {
  await upsertPermissionRequest(args);
}
