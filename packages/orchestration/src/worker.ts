import { fileURLToPath } from 'node:url';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';
import { loadConfig, type OrchestrationConfig } from './config';
import { reapRunnerContainers } from './runner-reaper';
import { sweepRunnerObservability } from './runner-observability';
import { sweepRetention } from './retention';

/**
 * Worker entrypoint: registers `RunWorkflow` and every activity on one task queue.
 *
 * Start it with `bun packages/orchestration/src/worker.ts` (or the compose `worker`
 * service). It is safe to kill and restart mid-run: Temporal re-delivers the in-flight
 * activity, the adapter session is recreated, and event writes are deduplicated by
 * `(runId, seq)`.
 *
 * Concurrency (ADR-013): a streaming run holds one activity slot for as long as it
 * streams; a run waiting for a human permission holds **none** (the wait lives in workflow
 * state). Slots are therefore only consumed by work that is actually doing something, so
 * the defaults are Temporal's (100/100) and can be tuned with
 * `WORKER_MAX_CONCURRENT_ACTIVITY_TASKS` / `WORKER_MAX_CONCURRENT_WORKFLOW_TASKS`.
 */
export async function createWorker(config: OrchestrationConfig = loadConfig()): Promise<Worker> {
  const connection = await NativeConnection.connect({ address: config.temporalAddress });

  const workflowsPath = fileURLToPath(new URL('./workflows/index.ts', import.meta.url));

  return Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: config.taskQueue,
    workflowsPath,
    activities,
    maxConcurrentActivityTaskExecutions: config.maxConcurrentActivityTaskExecutions,
    maxConcurrentWorkflowTaskExecutions: config.maxConcurrentWorkflowTaskExecutions,
    // Give in-flight activities time to finish cleanup before the worker is force-stopped.
    shutdownGraceTime: '90s',
    shutdownForceTime: '120s',
  });
}

export async function runWorker(config: OrchestrationConfig = loadConfig()): Promise<Worker> {
  const worker = await createWorker(config);

  const shutdown = (signal: string): void => {
    log('worker_shutdown', { signal });
    worker.shutdown();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  startHeartbeat(process.env.WORKER_HEARTBEAT_FILE);
  startRunnerReaper(config);
  startRunnerObservability(config);
  startRetentionSweep(config);

  log('worker_started', {
    address: config.temporalAddress,
    namespace: config.temporalNamespace,
    taskQueue: config.taskQueue,
    maxConcurrentActivityTaskExecutions: config.maxConcurrentActivityTaskExecutions,
    maxConcurrentWorkflowTaskExecutions: config.maxConcurrentWorkflowTaskExecutions,
  });

  await worker.run();
  log('worker_stopped', {});
  return worker;
}

/**
 * Periodic orphan-container reaper. The Docker socket and Postgres are both available to
 * the worker; this is the safety net for cancellations that land before `killRunner`, and
 * for workers that are killed mid-cleanup.
 */
function startRunnerReaper(config: OrchestrationConfig): void {
  if (!config.runnerReaperEnabled) return;

  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const result = await reapRunnerContainers(config);
      if (result.removed > 0 || result.wouldRemove > 0 || result.errors.length > 0) {
        log('runner_reaper', {
          scanned: result.scanned,
          removed: result.removed,
          wouldRemove: result.wouldRemove,
          skipped: result.skipped,
          errors: result.errors,
          actions: result.actions.filter((action) => action.action !== 'skipped'),
        });
      }
    } catch (error) {
      logError('runner_reaper_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, config.runnerReaperIntervalMs);
  timer.unref?.();
}

/**
 * Heartbeat-age alerts and lease expiry. Remote hosts have no Temporal/Postgres access,
 * so this central loop is the only place that can notice a host that stopped reporting.
 */
function startRunnerObservability(config: OrchestrationConfig): void {
  if (!config.remoteRunnerEnabled) return;

  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const result = await sweepRunnerObservability();
      if (result.alerts > 0 || result.expiredLeases > 0) {
        log('runner_observability', result);
      }
    } catch (error) {
      logError('runner_observability_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, config.remoteAlertIntervalMs);
  timer.unref?.();
}

/**
 * Retention sweep (change `add-retention-quotas-promotion`). Runs on the central worker
 * only: remote hosts have no Temporal/Postgres access and never execute it.
 * `RETENTION_ENABLED=0` disables it.
 */
function startRetentionSweep(config: OrchestrationConfig): void {
  if (!config.retentionEnabled) return;

  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await sweepRetention({ config });
    } catch (error) {
      logError('retention_sweep_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, config.retentionSweepIntervalMs);
  timer.unref?.();
}

/** Liveness file for compose healthchecks: mtime older than 60s means a dead worker. */
function startHeartbeat(file: string | undefined): void {
  if (!file) return;
  const write = (): void => {
    void Bun.write(file, new Date().toISOString()).catch(() => undefined);
  };
  write();
  setInterval(write, 15_000).unref?.();
}

function log(event: string, fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ level: 'info', event, ts: new Date().toISOString(), ...fields })}\n`);
}

function logError(event: string, fields: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ level: 'error', event, ts: new Date().toISOString(), ...fields })}\n`);
}

if (typeof Bun !== 'undefined' && Bun.main === import.meta.path) {
  runWorker().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        event: 'worker_crashed',
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exit(1);
  });
}
