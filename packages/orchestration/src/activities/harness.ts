
import type { FactoryEvent } from '@factory/adapters';
import { AdapterError } from '@factory/adapters';
import { loadConfig } from '../config';
import { heartbeat } from '../heartbeat';
import { isCancelRequested, setRunSessionRef, upsertStep } from '../db';
import { pumpSegment } from '../pump';
import { appendEvent, recordPermissionRequest } from './persist';
import {
  capabilitiesOf,
  dropStream,
  ensureSession,
  getOrCreateStream,
  getSession,
  getStream,
} from '../sessions';
import type {
  HarnessStartInfo,
  LeaseInfo,
  PermissionDecisionValue,
  PumpResult,
  RunInput,
  TerminalStatus,
} from '../types';

/**
 * Harness activities. The harness itself runs inside the runner (ADR-009); these
 * activities only drive the adapter that talks to it.
 *
 * `pumpEvents` is the single writer for the run's event log: it streams canonical
 * events from the adapter, appends each one, and returns as soon as the harness asks for
 * a human decision (ADR-013). The decision itself is a workflow-level durable wait, so a
 * permission-blocked run costs zero activity slots; the workflow calls `pumpEvents` again
 * with `fromSeq` to resume the same in-process stream after the decision is forwarded.
 * On a worker restart the adapter session and stream are recreated and already-persisted
 * events are deduplicated by `seq`.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export async function startHarness(args: {
  input: RunInput;
  lease: LeaseInfo;
  sessionRef?: string | null;
}): Promise<HarnessStartInfo> {
  const existed = getSession(args.input.runId) !== undefined;
  const entry = await ensureSession(args.input, {
    harnessUrl: args.lease.harnessUrl,
    sessionRef: args.sessionRef ?? null,
    password: process.env.OPENCODE_SERVER_PASSWORD,
  });

  if (entry.handle.sessionRef) {
    await setRunSessionRef(args.input.runId, entry.handle.sessionRef);
  }

  await upsertStep({
    runId: args.input.runId,
    stepId: 'start-harness',
    kind: 'harness',
    status: 'ok',
    detail: {
      harness: args.input.harness,
      model: args.input.model ?? null,
      harnessUrl: args.lease.harnessUrl ?? null,
      sessionRef: entry.handle.sessionRef ?? null,
      resumed: !existed && Boolean(args.sessionRef),
    },
  });

  return {
    sessionRef: entry.handle.sessionRef,
    harnessUrl: args.lease.harnessUrl,
    capabilities: capabilitiesOf(entry.adapter),
    resumed: !existed && Boolean(args.sessionRef),
  };
}

/**
 * Streams one segment of the adapter and returns as soon as the harness asks for a
 * permission decision (ADR-013).
 *
 * The segment loop lives in `pump.ts` (dependency-injected, unit-testable). This wrapper
 * supplies persistence, cancellation, heartbeats, and the per-run adapter stream, which is
 * cached in the session registry so a resumed segment continues the same iterator instead
 * of re-subscribing (no lost events, no scripted-adapter replay).
 *
 * `fromSeq` tells the pump which events are already persisted; `decided` carries the
 * decisions the workflow already holds, so a replayed `permission.requested` after a
 * worker restart is forwarded rather than surfaced again.
 */
export async function pumpEvents(args: {
  input: RunInput;
  lease: LeaseInfo;
  sessionRef?: string | null;
  fromSeq?: number;
  decided?: Record<string, PermissionDecisionValue>;
}): Promise<PumpResult> {
  const entry = await ensureSession(args.input, {
    harnessUrl: args.lease.harnessUrl,
    sessionRef: args.sessionRef ?? null,
    password: process.env.OPENCODE_SERVER_PASSWORD,
  });

  const { adapter, handle } = entry;
  const runId = args.input.runId;

  await upsertStep({
    runId,
    stepId: 'stream',
    kind: 'harness',
    status: 'running',
  });

  const hadStream = getStream(runId) !== undefined;
  const stream = getOrCreateStream(entry, runId);

  // The harness may resolve or drop a permission itself when the stream is aborted, so a
  // late reply can legitimately be a no-op. Anything else is a real failure.
  const respond = async (
    requestId: string,
    decision: PermissionDecisionValue,
  ): Promise<void> => {
    try {
      await adapter.respondToPermission(handle, requestId, decision);
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'permission_not_found') return;
      throw error;
    }
  };

  if (!hadStream && args.decided) {
    // A fresh stream means the adapter session was recreated (worker restart / retry).
    // Replay durable decisions best-effort so the harness is not left waiting on an answer
    // the workflow already has; a duplicate reply is a tolerated no-op.
    for (const [requestId, decision] of Object.entries(args.decided)) {
      try {
        await respond(requestId, decision);
      } catch {
        // best-effort: the harness may no longer know this request
      }
    }
  }

  const segment = await pumpSegment({
    runId,
    adapter,
    handle,
    iterator: stream.iterator,
    signal: stream.controller.signal,
    fromSeq: args.fromSeq,
    decided: args.decided,
    deps: {
      append: (event) => appendEvent({ runId, stepId: 'stream', event }),
      recordPermission: (request) => recordPermissionRequest(request),
      isCancelled: () => isCancelRequested(runId),
      respond,
      heartbeat: (details) => heartbeat(details),
      sleep,
    },
  });

  const droppedEvents = adapter.getStats?.().droppedEvents ?? 0;

  if (segment.stopReason === 'cancelled') {
    // Cooperative cancellation: stop the stream and let the workflow end the run.
    dropStream(runId);
  }

  if (segment.failure) {
    dropStream(runId);
    const failure = segment.failure;
    const code = failure instanceof AdapterError ? failure.code : 'harness_error';
    const message = failure instanceof Error ? failure.message : String(failure);
    await upsertStep({
      runId,
      stepId: 'stream',
      kind: 'harness',
      status: 'error',
      error: `${code}: ${message}`,
    });
    throw Object.assign(new Error(message), { code });
  }

  if (segment.stopReason === 'terminal' || segment.stopReason === 'closed') {
    dropStream(runId);
  }

  const status: TerminalStatus | 'running' =
    segment.stopReason === 'cancelled'
      ? 'cancelled'
      : segment.stopReason === 'permission'
        ? 'running'
        : (segment.terminalStatus ?? 'ok');

  await upsertStep({
    runId,
    stepId: 'stream',
    kind: 'harness',
    status,
    detail: {
      appended: segment.appended,
      lastSeq: segment.lastSeq,
      droppedEvents,
      stopReason: segment.stopReason,
      permissionRequestId: segment.permissionRequestId ?? null,
    },
  });

  const terminalStatus: TerminalStatus | null =
    segment.stopReason === 'permission' || status === 'running' ? null : status;

  return {
    terminalStatus,
    terminalSummary: segment.terminalSummary,
    lastSeq: segment.lastSeq,
    appended: segment.appended,
    droppedEvents,
    stopReason: segment.stopReason,
    permissionRequestId: segment.permissionRequestId,
    permissionAction: segment.permissionAction,
  };
}

/** Stops the harness session; safe to call when the session was never started. */
export async function cancelHarness(args: { input: RunInput; reason?: string }): Promise<void> {
  const entry = getSession(args.input.runId);
  if (!entry) return;
  try {
    await entry.adapter.cancel(entry.handle, args.reason ?? 'cancelled');
  } catch {
    // the harness may already be gone; cancellation must still succeed
  }
}

/** Forwards a permission decision to the harness (used for adapters with direct APIs). */
export async function respondPermission(args: {
  input: RunInput;
  requestId: string;
  decision: 'allow' | 'deny' | 'always';
}): Promise<void> {
  const entry = getSession(args.input.runId);
  if (!entry) return;
  await entry.adapter.respondToPermission(entry.handle, args.requestId, args.decision);
}
