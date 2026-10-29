
import type { FactoryEvent } from '@factory/adapters';
import { AdapterError } from '@factory/adapters';
import { loadConfig } from '../config';
import { heartbeat } from '../heartbeat';
import {
  isCancelRequested,
  readPermissionDecision,
  setRunSessionRef,
  upsertStep,
} from '../db';
import { appendEvent, appendTerminalEvent, recordPermissionRequest } from './persist';
import { capabilitiesOf, ensureSession, getSession } from '../sessions';
import type {
  HarnessStartInfo,
  LeaseInfo,
  PumpResult,
  RunInput,
  TerminalStatus,
} from '../types';

/**
 * Harness activities. The harness itself runs inside the runner (ADR-009); these
 * activities only drive the adapter that talks to it.
 *
 * `pumpEvents` is the single writer for the run's event log: it streams canonical
 * events from the adapter, appends each one, and blocks on interactive permissions.
 * It heartbeats on every event, so Temporal can detect a dead worker; on retry the
 * adapter session is recreated and already-persisted events are deduplicated by `seq`.
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
 * Streams the adapter until a terminal event, cancellation, or stream close.
 *
 * Permissions are a round trip (ADR-002): the API writes the decision to
 * `run_permissions`, this activity polls it and forwards the decision to the harness.
 * Polling (rather than a Temporal signal) keeps the API and the worker decoupled — they
 * only share Postgres — and survives a worker restart.
 */
export async function pumpEvents(args: {
  input: RunInput;
  lease: LeaseInfo;
  sessionRef?: string | null;
}): Promise<PumpResult> {
  const config = loadConfig();
  const entry = await ensureSession(args.input, {
    harnessUrl: args.lease.harnessUrl,
    sessionRef: args.sessionRef ?? null,
    password: process.env.OPENCODE_SERVER_PASSWORD,
  });

  const { adapter, handle } = entry;
  const runId = args.input.runId;
  const controller = new AbortController();

  await upsertStep({
    runId,
    stepId: 'stream',
    kind: 'harness',
    status: 'running',
  });

  const permissionTasks: Promise<void>[] = [];
  let permissionFailure: unknown = null;
  let terminalStatus: TerminalStatus | null = null;
  let terminalSummary: string | undefined;
  let appended = 0;
  let lastSeq = 0;
  let droppedEvents = 0;
  let failure: unknown = null;

  // The harness may resolve or drop a permission itself when the stream is aborted, so a
  // late reply can legitimately be a no-op. Anything else is a real failure.
  const respond = async (
    requestId: string,
    decision: 'allow' | 'deny' | 'always',
  ): Promise<void> => {
    try {
      await adapter.respondToPermission(handle, requestId, decision);
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'permission_not_found') return;
      throw error;
    }
  };

  const waitForDecision = async (requestId: string, requestAction: string): Promise<void> => {
    const started = Date.now();
    for (;;) {
      if (controller.signal.aborted) {
        await respond(requestId, 'deny');
        return;
      }
      // Cancellation is cooperative: the API records it in the read model, we poll.
      if (await isCancelRequested(runId)) {
        controller.abort();
        await respond(requestId, 'deny');
        return;
      }
      const decision = await readPermissionDecision(runId, requestId);
      if (decision) {
        heartbeat({ requestId, decision });
        await respond(requestId, decision);
        return;
      }
      if (Date.now() - started > config.permissionTimeoutMs) {
        await respond(requestId, 'deny');
        await appendTerminalEvent({
          runId,
          stepId: `permission-timeout-${requestId}`,
          status: 'error',
          summary: `permission ${requestAction} timed out`,
        });
        controller.abort();
        return;
      }
      await sleep(200);
      heartbeat({ waitingForPermission: requestId });
    }
  };

  let cancelSeen = false;
  try {
    const iterator = adapter.streamEvents(handle, controller.signal)[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<FactoryEvent>> | null = null;

    for (;;) {
      pending ??= iterator.next();
      const raced = await Promise.race([
        pending.then((result) => ({ kind: 'event' as const, result })),
        sleep(1_000).then(() => ({ kind: 'tick' as const })),
      ]);

      if (raced.kind === 'tick') {
        // Heartbeat while waiting on the harness, and notice cooperative cancellation even
        // when the harness is silent (e.g. a long model call).
        heartbeat({ waitingForEvent: true });
        if (!cancelSeen && (await isCancelRequested(runId))) {
          cancelSeen = true;
          controller.abort();
        }
        continue;
      }

      pending = null;
      if (raced.result.done) break;
      await handleEvent(raced.result.value);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      // Cancellation surfaces as an adapter abort; that is expected, not a failure.
      terminalStatus ??= 'cancelled';
    } else {
      failure = error;
    }
  } finally {
    await Promise.allSettled(permissionTasks);
    if (permissionFailure && !failure) failure = permissionFailure;
    const stats = adapter.getStats?.();
    droppedEvents = stats?.droppedEvents ?? 0;
  }

  async function handleEvent(event: FactoryEvent): Promise<void> {
    const result = await appendEvent({ runId, stepId: 'stream', event });
    if (result.appended) {
      appended += 1;
      lastSeq = Math.max(lastSeq, result.seq ?? 0);
    }

    if (event.type === 'permission.requested') {
      await recordPermissionRequest({
        runId,
        requestId: event.requestId,
        action: event.action,
        detail: event.detail,
      });
      // Attach the rejection handler immediately: an unhandled rejection would kill the
      // worker process, and a permission failure must surface as a run error, not a crash.
      permissionTasks.push(
        waitForDecision(event.requestId, event.action).catch((error: unknown) => {
          permissionFailure ??= error;
          controller.abort();
        }),
      );
    }

    if (event.type === 'run.completed') {
      terminalStatus = event.status;
      terminalSummary = event.summary;
    }
  }

  if (failure) {
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

  const status = terminalStatus ?? (controller.signal.aborted ? 'cancelled' : 'ok');
  await upsertStep({
    runId,
    stepId: 'stream',
    kind: 'harness',
    status: status === 'ok' ? 'ok' : status === 'cancelled' ? 'cancelled' : 'error',
    detail: { appended, lastSeq, droppedEvents },
  });

  return { terminalStatus: status, terminalSummary, lastSeq, appended, droppedEvents };
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
