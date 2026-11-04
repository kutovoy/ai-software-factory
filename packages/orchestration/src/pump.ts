import type {
  FactoryEvent,
  HarnessAdapter,
  PermissionDecision,
  SessionHandle,
} from '@factory/adapters';
import type {
  PermissionDecisionValue,
  PumpStopReason,
  TerminalStatus,
} from './types';

/**
 * Event-pump segment (ADR-013).
 *
 * A segment consumes the adapter's event iterator until the first of:
 *   - `permission.requested` → returns immediately with `stopReason: 'permission'`, so the
 *     human decision becomes a workflow-level durable wait instead of an occupied activity
 *     slot. The permission event is persisted exactly once before returning.
 *   - `run.completed` → `stopReason: 'terminal'`.
 *   - cooperative cancellation (API wrote `runs.cancel_requested_at`) → `'cancelled'`.
 *   - the adapter stream closing without a terminal event → `'closed'`.
 *
 * Deliberately free of Temporal/Node imports so it can be unit-tested directly; the
 * activity wrapper (`pumpEvents`) injects persistence, cancellation and heartbeat deps.
 */

export interface PumpDeps {
  /** Persists one canonical event; must be idempotent by `(runId, seq)`. */
  append(event: FactoryEvent): Promise<{ appended: boolean; seq: number | null }>;
  /** Records the permission request in the read model (idempotent upsert). */
  recordPermission(request: {
    runId: string;
    requestId: string;
    action: string;
    detail: unknown;
  }): Promise<void>;
  /** Cooperative cancellation, read from the read model. */
  isCancelled(): Promise<boolean>;
  /** Forwards a decision to the harness adapter. */
  respond(requestId: string, decision: PermissionDecision): Promise<void>;
  /** Activity heartbeat (no-op outside an activity). */
  heartbeat(details?: Record<string, unknown>): void;
  sleep(ms: number): Promise<void>;
}

export interface PumpSegmentArgs {
  runId: string;
  adapter: HarnessAdapter;
  handle: SessionHandle;
  /** The adapter's event iterator. Reused across segments so no event is lost. */
  iterator: AsyncIterator<FactoryEvent>;
  /** Aborts the adapter stream; owned by the caller so it survives across segments. */
  signal: AbortSignal;
  /** Events with `seq <= fromSeq` are already persisted (segment resume / retry). */
  fromSeq?: number;
  /**
   * Decisions the workflow already took. When a replayed `permission.requested` for one of
   * these is seen (e.g. after a worker restart) it is forwarded instead of stopping again.
   */
  decided?: Record<string, PermissionDecisionValue>;
  deps: PumpDeps;
  /** Heartbeat + cancellation poll cadence while the harness is silent. */
  tickMs?: number;
  /** Hard spend cap for this segment (USD); crossing it stops the run. */
  maxCostUsd?: number;
}

export interface PumpSegmentResult {
  stopReason: PumpStopReason;
  terminalStatus: TerminalStatus | null;
  terminalSummary?: string;
  lastSeq: number;
  appended: number;
  permissionRequestId?: string;
  permissionAction?: string;
  /** Cumulative cost observed in this segment. */
  costUsd: number;
  /** Set when the adapter threw or a budget cap was crossed. */
  failure?: unknown;
}

export async function pumpSegment(args: PumpSegmentArgs): Promise<PumpSegmentResult> {
  const { deps } = args;
  const tickMs = args.tickMs ?? 1_000;
  const fromSeq = args.fromSeq ?? 0;

  let lastSeq = fromSeq;
  let appended = 0;
  let terminalStatus: TerminalStatus | null = null;
  let terminalSummary: string | undefined;
  let failure: unknown;
  let costUsd = 0;

  let stop: PumpSegmentResult | null = null;
  let pending: Promise<IteratorResult<FactoryEvent>> | null = args.iterator.next();

  try {
    while (!stop) {
      pending ??= args.iterator.next();
      const raced = await Promise.race([
        pending.then((result) => ({ kind: 'event' as const, result })),
        deps.sleep(tickMs).then(() => ({ kind: 'tick' as const })),
      ]);

      if (raced.kind === 'tick') {
        // Heartbeat while the harness is silent, and notice cooperative cancellation even
        // when nothing is streaming (e.g. a long model call).
        deps.heartbeat({ waitingForEvent: true });
        if (!args.signal.aborted && (await deps.isCancelled())) {
          stop = {
            stopReason: 'cancelled',
            terminalStatus: 'cancelled',
            lastSeq,
            appended,
            costUsd,
          };
        }
        continue;
      }

      pending = null;
      if (raced.result.done) {
        stop = {
          stopReason: terminalStatus ? 'terminal' : args.signal.aborted ? 'cancelled' : 'closed',
          terminalStatus,
          terminalSummary,
          lastSeq,
          appended,
          costUsd,
        };
        break;
      }

      const event = raced.result.value;

      // Events already persisted by a previous segment/attempt are not written twice.
      if (event.seq > fromSeq) {
        const written = await deps.append(event);
        if (written.appended) {
          appended += 1;
          lastSeq = Math.max(lastSeq, written.seq ?? event.seq);
        }
      } else {
        lastSeq = Math.max(lastSeq, event.seq);
      }

      if (event.type === 'usage.updated') {
        costUsd += event.costUsd ?? 0;
        if (args.maxCostUsd !== undefined && costUsd > args.maxCostUsd) {
          failure = Object.assign(
            new Error(
              `budget_exhausted: run cost ${costUsd.toFixed(6)} exceeded cap ${args.maxCostUsd.toFixed(6)} USD`,
            ),
            { code: 'budget_exhausted' },
          );
          stop = {
            stopReason: 'closed',
            terminalStatus: 'error',
            lastSeq,
            appended,
            costUsd,
            failure,
          };
          break;
        }
      }

      if (event.type === 'permission.requested') {
        await deps.recordPermission({
          runId: args.runId,
          requestId: event.requestId,
          action: event.action,
          detail: event.detail,
        });

        const already = args.decided?.[event.requestId];
        if (already) {
          // A decision is already durable in workflow state (restart / retry): forward it
          // and keep pumping instead of stopping again.
          await deps.respond(event.requestId, already);
          continue;
        }

        stop = {
          stopReason: 'permission',
          terminalStatus,
          terminalSummary,
          lastSeq,
          appended,
          costUsd,
          permissionRequestId: event.requestId,
          permissionAction: event.action,
        };
        break;
      }

      if (event.type === 'run.completed') {
        terminalStatus = event.status;
        terminalSummary = event.summary;
        stop = {
          stopReason: 'terminal',
          terminalStatus,
          terminalSummary,
          lastSeq,
          appended,
          costUsd,
        };
        break;
      }
    }
  } catch (error) {
    if (args.signal.aborted) {
      // Cancellation surfaces as an adapter abort; that is expected, not a failure.
      stop = {
        stopReason: 'cancelled',
        terminalStatus: 'cancelled',
        lastSeq,
        appended,
        costUsd,
      };
    } else {
      failure = error;
      stop = { stopReason: 'closed', terminalStatus, lastSeq, appended, costUsd, failure };
    }
  }

  return stop;
}
