import { resolve, sep } from 'node:path';
import { removeDir, runCommand } from '@factory/runners';
import { describeRun, temporalHealthy } from './client';
import type { OrchestrationConfig } from './config';
import { finishRun, getSql, upsertStep } from './db';

/**
 * Label-based runner reaper.
 *
 * The Docker backend creates one detached container per run. Normal cleanup is
 * `RunWorkflow` → `killRunner`, but a cancellation can land before that activity is
 * scheduled, a worker can be killed mid-cleanup, or a lease can fail after `docker run`.
 * This reaper is the safety net: it compares label-managed containers with the run read
 * model and Temporal, then removes containers whose run is terminal, missing, or has no
 * live workflow.
 *
 * Labels are already written by `DockerRunnerBackend`:
 *   factory.runner    deterministic runner id
 *   factory.run       run id
 *   factory.workspace worker-local workspace path
 */

export interface ManagedContainer {
  id: string;
  name: string;
  runId: string;
  workspace: string;
  createdAt: string;
  ageMs: number;
}

export interface RunnerReaperOptions {
  dryRun?: boolean;
  maxAgeMs?: number;
  graceMs?: number;
  now?: number;
}

export interface RunnerReaperDeps {
  listContainers: () => Promise<ManagedContainer[]>;
  runStatus: (runId: string) => Promise<string | null>;
  workflowStatus: (runId: string) => Promise<'running' | 'closed' | 'missing' | 'unavailable'>;
  removeContainer: (id: string) => Promise<void>;
  removeWorkspace: (path: string) => Promise<void>;
  markRunOrphaned: (runId: string, reason: string) => Promise<void>;
}

export interface ReaperAction {
  containerId: string;
  containerName: string;
  runId: string;
  ageMs: number;
  action: 'removed' | 'would_remove' | 'skipped';
  reason: string;
}

export interface RunnerReaperResult {
  scanned: number;
  removed: number;
  wouldRemove: number;
  skipped: number;
  errors: string[];
  actions: ReaperAction[];
}

const TERMINAL_RUN_STATUSES = new Set(['ok', 'error', 'cancelled']);

function parseDockerInspect(value: unknown, now: number): ManagedContainer[] {
  if (!Array.isArray(value)) return [];
  const containers: ManagedContainer[] = [];
  for (const entry of value) {
    const record = (entry ?? {}) as {
      Id?: unknown;
      Name?: unknown;
      Created?: unknown;
      Config?: { Labels?: Record<string, string> | null };
    };
    const id = typeof record.Id === 'string' ? record.Id : '';
    if (!id) continue;
    const labels = record.Config?.Labels ?? {};
    const created = typeof record.Created === 'string' ? record.Created : '';
    const createdMs = Date.parse(created);
    containers.push({
      id,
      name: typeof record.Name === 'string' ? record.Name.replace(/^\//, '') : id.slice(0, 12),
      runId: labels['factory.run'] ?? '',
      workspace: labels['factory.workspace'] ?? '',
      createdAt: created,
      ageMs: Number.isFinite(createdMs) ? Math.max(0, now - createdMs) : 0,
    });
  }
  return containers;
}

export function defaultReaperDeps(config: OrchestrationConfig): RunnerReaperDeps {
  return {
    listContainers: async () => {
      const ids = await runCommand(
        ['docker', 'ps', '-aq', '--filter', 'label=factory.runner'],
        { timeoutMs: 30_000 },
      );
      if (ids.code !== 0) {
        throw new Error(`docker ps failed: ${ids.stderr.slice(-1000)}`);
      }
      const containerIds = ids.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (containerIds.length === 0) return [];

      const inspected = await runCommand(['docker', 'inspect', ...containerIds], {
        timeoutMs: 30_000,
      });
      if (inspected.code !== 0) {
        throw new Error(`docker inspect failed: ${inspected.stderr.slice(-1000)}`);
      }
      return parseDockerInspect(JSON.parse(inspected.stdout), Date.now());
    },
    runStatus: async (runId) => {
      const rows = (await getSql()`
        select status from runs where id = ${runId} limit 1
      `) as { status: string }[];
      return rows[0]?.status ?? null;
    },
    workflowStatus: async (runId) => {
      const health = await temporalHealthy(config);
      if (!health.ok) return 'unavailable';
      const description = await describeRun(runId, config);
      if (!description) return 'missing';
      return description.status === 'RUNNING' ? 'running' : 'closed';
    },
    removeContainer: async (id) => {
      const result = await runCommand(['docker', 'rm', '-f', id], { timeoutMs: 30_000 });
      if (
        result.code !== 0 &&
        !/No such container/i.test(result.stderr) &&
        !/already in progress/i.test(result.stderr)
      ) {
        throw new Error(`docker rm failed for ${id}: ${result.stderr.slice(-1000)}`);
      }
    },
    removeWorkspace: async (path) => {
      const resolved = resolve(path);
      const runsRoot = `${resolve(config.runsDir)}${sep}`;
      const allowed =
        resolved.startsWith('/tmp/factory-run-') || resolved.startsWith(runsRoot);
      if (allowed) await removeDir(resolved);
    },
    markRunOrphaned: async (runId, reason) => {
      const error = `runner_orphaned: ${reason}`;
      await finishRun({
        runId,
        status: 'error',
        summary: 'runner orphaned; the sandbox was reaped',
        error,
      });
      await upsertStep({
        runId,
        stepId: 'runner-reaper',
        kind: 'runner',
        status: 'error',
        detail: { reason },
        error,
      }).catch(() => undefined);
    },
  };
}

/**
 * Reaps orphaned sandbox containers. Terminal runs are removed immediately; a `running`
 * run is removed when Temporal says its workflow is closed or missing (after a short
 * grace), or when the container exceeds the max age with no live workflow. If Temporal is
 * unreachable, running containers are skipped so an outage cannot kill live work.
 */
export async function reapRunnerContainers(
  config: OrchestrationConfig,
  options: RunnerReaperOptions = {},
  deps: RunnerReaperDeps = defaultReaperDeps(config),
): Promise<RunnerReaperResult> {
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun ?? config.runnerReaperDryRun;
  const maxAgeMs = options.maxAgeMs ?? config.runnerReaperMaxAgeMs;
  const graceMs = options.graceMs ?? config.runnerReaperGraceMs;

  const containers = await deps.listContainers();
  const result: RunnerReaperResult = {
    scanned: containers.length,
    removed: 0,
    wouldRemove: 0,
    skipped: 0,
    errors: [],
    actions: [],
  };

  for (const container of containers) {
    let reason: string | null = null;
    try {
      if (!container.runId) {
        reason = 'label_missing';
      } else {
        const status = await deps.runStatus(container.runId);
        if (!status) {
          reason = 'run_missing';
        } else if (TERMINAL_RUN_STATUSES.has(status)) {
          reason = 'run_terminal';
        } else if (status === 'running') {
          const workflow = await deps.workflowStatus(container.runId);
          if (workflow === 'unavailable') {
            result.skipped += 1;
            result.actions.push({
              containerId: container.id,
              containerName: container.name,
              runId: container.runId,
              ageMs: container.ageMs,
              action: 'skipped',
              reason: 'temporal_unavailable',
            });
            continue;
          }
          if (workflow === 'closed') reason = 'workflow_closed';
          else if (workflow === 'missing' && container.ageMs >= graceMs) {
            reason = 'workflow_missing';
          } else if (container.ageMs >= maxAgeMs) {
            reason = 'max_age';
          }
        } else if (container.ageMs >= maxAgeMs) {
          reason = 'max_age';
        }
      }

      if (!reason) {
        result.skipped += 1;
        result.actions.push({
          containerId: container.id,
          containerName: container.name,
          runId: container.runId,
          ageMs: container.ageMs,
          action: 'skipped',
          reason: 'active_or_recent',
        });
        continue;
      }

      if (dryRun) {
        result.wouldRemove += 1;
        result.actions.push({
          containerId: container.id,
          containerName: container.name,
          runId: container.runId,
          ageMs: container.ageMs,
          action: 'would_remove',
          reason,
        });
        continue;
      }

      await deps.removeContainer(container.id);
      if (container.workspace) {
        await deps.removeWorkspace(container.workspace).catch(() => undefined);
      }
      if (container.runId) {
        const status = await deps.runStatus(container.runId);
        if (status === 'running') {
          await deps.markRunOrphaned(container.runId, reason).catch(() => undefined);
        }
      }
      result.removed += 1;
      result.actions.push({
        containerId: container.id,
        containerName: container.name,
        runId: container.runId,
        ageMs: container.ageMs,
        action: 'removed',
        reason,
      });
    } catch (error) {
      result.errors.push(
        `${container.name || container.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return result;
}
