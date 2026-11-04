import {
  CancellationScope,
  condition,
  defineSignal,
  defineUpdate,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import { describeFailure } from '../failures';
import type {
  LeaseInfo,
  PermissionDecisionAck,
  PermissionDecisionInput,
  PermissionDecisionValue,
  ProxyCredentials,
  PumpResult,
  RunArtifact,
  RunInput,
  RunOutcome,
  TerminalStatus,
} from '../types';

/**
 * RunWorkflow — one workflow per run (ADR-001).
 *
 * Shape: persist → mint proxy token → lease runner → start harness → stream events →
 * artifacts → terminal state → revoke token → kill sandbox.
 *
 * Retry/timeout policy (task 1.6):
 *   - persistence activities: 2 min start-to-close, 10 attempts, exponential backoff
 *     (0.5s → 30s). They are idempotent by `runId+stepId`, so retries are free.
 *   - runner activities: 15 min start-to-close, 60s heartbeat, 3 attempts. A lease retry
 *     re-attaches to the same `runnerId` instead of creating a second sandbox.
 *   - harness activities: 2 h start-to-close, 30s heartbeat, 5 attempts. The heartbeat
 *     keeps a long stream alive; a retry recreates the session and deduplicates events
 *     by `seq`, so no event is written twice.
 *   - proxy token activities: 1 min, 5 attempts (revocation is idempotent).
 * A transient failure is retried with backoff; after the limit the run ends `status: error`
 * with the failure recorded on the run row.
 *
 * Human gates (ADR-013): `pumpEvents` returns as soon as the harness asks for a permission
 * decision. The workflow then waits on workflow state (`condition`) — no activity slot is
 * held while a human thinks, so abandoned permission-blocked runs cannot starve the queue.
 * The decision arrives as a Temporal **Update** (`submitPermissionDecision`, preferred) or
 * a **Signal** (`permissionDecision`, fallback); both handlers are registered at workflow
 * start so a decision posted immediately after `permission.requested` cannot race the
 * handler registration. The wait has no fixed cost: only the SLA timer (auto-deny + error)
 * and a slow cancellation probe touch the DB.
 */

const persistence = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 10,
  },
});

const runner = proxyActivities<typeof activities>({
  startToCloseTimeout: '15 minutes',
  heartbeatTimeout: '60 seconds',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
    maximumAttempts: 3,
  },
});

const harness = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 hours',
  heartbeatTimeout: '30 seconds',
  // ABANDON: cancellation never propagates to the pump activity. A graceful worker shutdown
  // must not turn a resumable run into a cancelled one; cancellation is cooperative and
  // travels through the read model (`runs.cancel_requested_at`) instead.
  cancellationType: 'ABANDON',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 5,
  },
});

const proxy = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '10 seconds',
    maximumAttempts: 5,
  },
});

/** Graceful cancellation. The API sends this instead of force-terminating the workflow. */
export const cancelSignal = defineSignal<[string?]>('cancel');

/** Preferred decision channel: a Temporal Update with a synchronous acknowledgement. */
export const permissionDecisionUpdate = defineUpdate<
  PermissionDecisionAck,
  [PermissionDecisionInput]
>('submitPermissionDecision');

/** Fallback decision channel for clients/workers that cannot use Updates. */
export const permissionDecisionSignal = defineSignal<[PermissionDecisionInput]>(
  'permissionDecision',
);

/** Default SLA when the run input does not carry one. */
const DEFAULT_PERMISSION_TIMEOUT_MS = 30 * 60 * 1000;
/** How often a permission wait re-checks the read model for a cancellation. */
const CANCEL_PROBE_MS = 15 * 1000;

export async function RunWorkflow(input: RunInput): Promise<RunOutcome> {
  let cancelRequested = false;
  let cancelReason: string | undefined;

  /** Decisions delivered while the workflow was running (durable workflow state). */
  const decisions = new Map<string, PermissionDecisionValue>();

  const recordDecision = (payload: PermissionDecisionInput): PermissionDecisionAck => {
    decisions.set(payload.requestId, payload.decision);
    return {
      accepted: true,
      requestId: payload.requestId,
      decision: payload.decision,
    };
  };

  // Registered before the first await: the API may post a decision the instant the
  // `permission.requested` event is visible in the read model.
  setHandler(permissionDecisionUpdate, recordDecision);
  // A Signal handler must return void; the same decision is recorded either way.
  setHandler(permissionDecisionSignal, (payload: PermissionDecisionInput) => {
    recordDecision(payload);
  });

  // Cancellation is cooperative (see `pumpEvents`): the API writes
  // `runs.cancel_requested_at`, the pump polls it, aborts the adapter, and the run ends
  // `cancelled`. The signal is recorded here for the summary and as an audit breadcrumb;
  // it also wakes a permission wait immediately.
  setHandler(cancelSignal, (reason?: string) => {
    cancelRequested = true;
    cancelReason = reason ?? 'cancelled';
  });

  const workflowId = workflowInfo().workflowId;
  const runId = input.runId;
  const permissionTimeoutMs = input.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;

  await persistence.persistRun({ input, workflowId });

  const credentials: ProxyCredentials | null = await proxy.issueProxyToken({
    runId,
    models: input.proxyModels,
  });

  // The sandbox only ever sees the proxy base URL and a per-run token (ADR-011).
  const harnessEnv: Record<string, string> | undefined = credentials
    ? {
        OPENAI_BASE_URL: credentials.baseUrl,
        OPENAI_API_KEY: credentials.token,
      }
    : undefined;

  let lease: LeaseInfo | undefined;
  let pump: PumpResult | null = null;
  let failure: string | undefined;
  let cancelled = false;
  /** Decisions already forwarded to the harness (also sent to a recreated session). */
  const decided: Record<string, PermissionDecisionValue> = {};
  let lastSeq = 0;

  try {
    lease = await runner.leaseRunner({ input, harnessEnv });

    // Setup commands come from the definition's runner resource; best-effort, recorded
    // per step, never fatal (they run inside the sandbox, never on the API host).
    if (lease && !lease.ephemeral && input.setupCommands?.length) {
      for (const [index, command] of input.setupCommands.entries()) {
        try {
          await runner.runCommand({
            input,
            lease,
            command,
            stepId: `setup-${index + 1}`,
          });
        } catch (error) {
          await persistence.persistStep({
            runId,
            stepId: `setup-${index + 1}`,
            kind: 'exec',
            status: 'error',
            error: describeFailure(error),
          });
        }
      }
    }

    if (cancelRequested) {
      cancelled = true;
    } else {
      const started = await harness.startHarness({
        input,
        lease,
        sessionRef: null,
      });
      if (cancelRequested) {
        cancelled = true;
      } else {
        // Pump in segments: each segment ends at a permission request (ADR-013), so the
        // human wait below happens in workflow state, not in an activity slot.
        for (;;) {
          pump = await harness.pumpEvents({
            input,
            lease: lease as LeaseInfo,
            sessionRef: started.sessionRef ?? null,
            fromSeq: lastSeq,
            decided,
          });
          lastSeq = pump.lastSeq;

          if (pump.stopReason !== 'permission') break;

          const requestId = pump.permissionRequestId;
          if (!requestId) break; // defensive: never wait without an id
          const action = pump.permissionAction ?? 'permission';

          // Factory stage runs are unattended agents: tool permissions are auto-allowed.
          // Chat runs keep the ADR-013 durable wait.
          if (input.autoAllowPermissions) {
            decided[requestId] = 'allow';
            await harness.respondPermission({ input, requestId, decision: 'allow' });
            continue;
          }

          // Durable wait. `condition` resolves on the Update/Signal handler, or after a
          // slice, in which case we re-check cancellation recorded in the read model.
          let remaining = permissionTimeoutMs;
          while (
            !cancelRequested &&
            !decisions.has(requestId) &&
            remaining > 0
          ) {
            const slice = Math.min(remaining, CANCEL_PROBE_MS);
            await condition(
              () => cancelRequested || decisions.has(requestId),
              slice,
            );
            remaining -= slice;
            if (!cancelRequested && !decisions.has(requestId)) {
              if (await persistence.isRunCancelled({ runId })) {
                cancelRequested = true;
              }
            }
          }

          if (cancelRequested) {
            cancelled = true;
            break;
          }

          const decision = decisions.get(requestId);
          if (!decision) {
            // SLA exceeded: auto-deny so the harness unblocks, then fail the run.
            // The console maps `permission_timeout` to a remediation hint.
            failure = `permission_timeout: permission ${action} timed out`;
            try {
              await harness.respondPermission({ input, requestId, decision: 'deny' });
            } catch {
              // the harness may already be gone; the run still ends as error
            }
            await persistence.appendTerminalEvent({
              runId,
              stepId: `permission-timeout-${requestId}`,
              status: 'error',
              summary: failure,
            });
            break;
          }

          decisions.delete(requestId);
          decided[requestId] = decision;
          await harness.respondPermission({ input, requestId, decision });
        }
      }
    }
  } catch (error) {
    if (cancelRequested || isCancellation(error)) {
      cancelled = true;
    } else {
      // Temporal hands the workflow an `ActivityFailure` whose message is the wrapper
      // `Activity task failed`. Record the cause chain instead (code + message) so the run
      // row, the `workflow-error` step and the terminal summary all say what broke.
      failure = describeFailure(error);
      await persistence.persistStep({
        runId,
        stepId: 'workflow-error',
        kind: 'workflow',
        status: 'error',
        error: failure,
      });
    }
  }

  const status: TerminalStatus = cancelled
    ? 'cancelled'
    : failure
      ? 'error'
      : (pump?.terminalStatus ?? 'ok');

  const summary = cancelled
    ? (cancelReason ?? pump?.terminalSummary ?? 'cancelled')
    : failure
      ? failure
      : pump?.terminalSummary;

  let artifacts: RunArtifact[] = [];
  let costUsd: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let terminalLastSeq = 0;

  /**
   * Every post-run step lives in one non-cancellable scope. Previously only
   * `collectArtifacts` and the final writes were wrapped; `readTerminalState` sat between
   * them, so a cancellation delivered at that await skipped `finishRunActivity` and
   * `killRunner`, leaving the sandbox container and a `running` run row behind.
   *
   * Each step is best-effort except the terminal event: the run row is the read model, and
   * the runner reaper reconciles a row that could not be finished. `killRunner` is always
   * attempted last, even when artifact collection or finish fails.
   */
  await CancellationScope.nonCancellable(async () => {
    if (status === 'cancelled') {
      try {
        await harness.cancelHarness({ input, reason: cancelReason ?? 'cancelled' });
      } catch {
        // The harness may already be gone; the terminal event still records the outcome.
      }
    }

    // Exactly one terminal event, whether or not the adapter emitted one. If the write
    // fails, still continue to the runner kill: a container must not outlive the run.
    try {
      await persistence.appendTerminalEvent({
        runId,
        stepId: 'terminal',
        status,
        summary,
      });
    } catch (error) {
      await persistence
        .persistStep({
          runId,
          stepId: 'terminal-event-error',
          kind: 'persist',
          status: 'error',
          error: describeFailure(error),
        })
        .catch(() => undefined);
    }

    if (lease) {
      try {
        const collected = await runner.collectArtifacts({
          input,
          lease: lease as LeaseInfo,
        });
        artifacts = collected.artifacts;
        if (collected.usage) {
          costUsd = collected.usage.costUsd ?? null;
          inputTokens = collected.usage.inputTokens;
          outputTokens = collected.usage.outputTokens;
        }
      } catch (error) {
        // Artifact collection must not change the run's verdict; record and continue.
        await persistence
          .persistStep({
            runId,
            stepId: 'artifacts-error',
            kind: 'artifacts',
            status: 'error',
            error: describeFailure(error),
          })
          .catch(() => undefined);
      }
    }

    try {
      const terminal = await persistence.readTerminalState({ runId });
      terminalLastSeq = terminal.lastSeq;
    } catch (error) {
      await persistence
        .persistStep({
          runId,
          stepId: 'terminal-state-error',
          kind: 'persist',
          status: 'error',
          error: describeFailure(error),
        })
        .catch(() => undefined);
    }

    try {
      await persistence.finishRunActivity({
        runId,
        status,
        summary: summary ?? null,
        error: status === 'error' ? (failure ?? summary ?? 'run failed') : null,
        costUsd,
        inputTokens,
        outputTokens,
        artifacts,
      });
    } catch (error) {
      await persistence
        .persistStep({
          runId,
          stepId: 'finish-run-error',
          kind: 'persist',
          status: 'error',
          error: describeFailure(error),
        })
        .catch(() => undefined);
    }

    try {
      await proxy.revokeProxyToken({ runId });
    } catch (error) {
      await persistence
        .persistStep({
          runId,
          stepId: 'revoke-proxy-token-error',
          kind: 'proxy',
          status: 'error',
          error: describeFailure(error),
        })
        .catch(() => undefined);
    }

    if (lease) {
      try {
        await runner.killRunner({ input, lease });
      } catch (error) {
        await persistence
          .persistStep({
            runId,
            stepId: 'kill-runner-error',
            kind: 'runner',
            status: 'error',
            error: describeFailure(error),
          })
          .catch(() => undefined);
      }
    }
  });

  return {
    runId,
    status,
    lastSeq: terminalLastSeq || lastSeq || pump?.lastSeq || 0,
    summary,
  };
}
