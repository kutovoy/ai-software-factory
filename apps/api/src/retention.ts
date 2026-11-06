import { z } from 'zod';
import {
  sweepFactoryRetention,
  type RetentionSweepResult,
} from '@factory/orchestration';
import { toOrchestrationConfig, type ApiConfig } from './config';
import { log } from './logger';

/**
 * Manual run GC (change `add-retention-quotas-promotion`, spec `retention` / requirement
 * "Manual run GC").
 *
 * `POST /api/v1/factories/{factoryId}/runs/gc` applies the same rules as the worker sweep:
 * terminal runs older than `days` and beyond the newest `keep` per factory are removed with
 * their rows, `runs/<id>/` directory and stored artifact blobs. `dryRun` reports the plan
 * without deleting anything. The route resolves the factory first (a foreign id is a `404`).
 */

export const runGcBodySchema = z
  .object({
    actor: z.string().min(1).max(120),
    reason: z.string().min(1).max(2000),
    /** Override the configured age window, in days. */
    days: z.number().int().min(0).max(3650).optional(),
    /** Override the configured keep count (newest terminal runs per factory). */
    keep: z.number().int().min(0).max(100_000).optional(),
    /** Report the plan without deleting anything. */
    dryRun: z.boolean().optional(),
  })
  .strict();

export type RunGcBody = z.infer<typeof runGcBodySchema>;

export type RunGcResponse = RetentionSweepResult;

/** Runs the factory-scoped retention sweep and records an auditable structured log line. */
export async function gcRunsForApi(
  config: ApiConfig,
  factory: string,
  body: RunGcBody,
): Promise<RunGcResponse> {
  const result = await sweepFactoryRetention({
    config: toOrchestrationConfig(config),
    factory,
    ...(body.days === undefined ? {} : { days: body.days }),
    ...(body.keep === undefined ? {} : { keep: body.keep }),
    ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun }),
    actor: body.actor,
    reason: body.reason,
  });

  log('info', 'runs_gc', {
    factory,
    actor: body.actor,
    reason: body.reason,
    dryRun: result.dryRun,
    days: result.days,
    keep: result.keep,
    scanned: result.scanned,
    removed: result.removed,
    kept: result.kept,
    protected: result.protected,
    artifactsDeleted: result.artifactsDeleted,
    artifactsFailed: result.artifactsFailed,
    runDirsRemoved: result.runDirsRemoved,
    canaryTreesRemoved: result.canaryTrees.removed,
    errors: result.errors.length,
  });

  return result;
}
