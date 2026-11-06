import { existsSync, rmSync } from 'node:fs';
import { artifactStoreFromConfig, type S3ArtifactStore } from './artifact-store';
import { collectCanaryTrees } from './canary-apply';
import { loadConfig, type OrchestrationConfig } from './config';
import { getSql, parseJsonb } from './db';
import { runDir } from './run-dir';
import type { RunArtifact } from './types';

/**
 * Retention / GC (change `add-retention-quotas-promotion`, spec `retention`).
 *
 * Bounds disk and object-store growth without deleting evidence an operator still needs:
 *  - Only **terminal** runs (`ok`, `error`, `cancelled`) are candidates.
 *  - The newest `keep` terminal runs per factory are always retained, whatever their age.
 *  - `pending`/`running` runs are protected, as is any row whose age cannot be determined.
 *  - A run is eligible only when it is older than the cutoff *and* beyond the keep count.
 *
 * Order of operations: capture artifact keys from the read model, delete `run_secrets` and
 * `score_runs` explicitly (no FK cascade from `runs`), delete the run (events/steps/
 * permissions/proxy rows cascade), then remove `runs/<id>/`, then attempt best-effort blob
 * deletion. A blob failure is reported but never rolls back the database delete. Every step
 * is idempotent: a retry deletes nothing that is already gone and tolerates missing files.
 */

/** Statuses that make a run eligible for retention. Anything else is protected. */
export const TERMINAL_RUN_STATUSES = ['ok', 'error', 'cancelled'] as const;

/** Neutral run row shape used by the pure selector (tests and the sweep share it). */
export interface RetentionRunRow {
  id: string;
  status: string;
  startedAt?: string | Date | number | null;
  endedAt?: string | Date | number | null;
  /** `runs.artifacts` as stored (jsonb array); only `storageKey` matters here. */
  artifacts?: unknown;
}

export interface RetentionSelectionOptions {
  /** Reference time; defaults to now. */
  now?: Date | number;
  /** Age window in days. A run is "old" when its timestamp is before `now - days`. */
  days: number;
  /** Newest terminal runs per factory that are always kept. */
  keep: number;
}

export interface RetentionSelection {
  scanned: number;
  /** Newest `keep` terminal runs; always retained. */
  kept: string[];
  /** Non-terminal runs (and undatable rows): never removed. */
  protected: string[];
  /** Eligible terminal runs, oldest first. */
  remove: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isTerminal(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowMsOf(now: Date | number | undefined): number {
  if (typeof now === 'number') return Number.isFinite(now) ? now : Date.now();
  if (now instanceof Date) return now.getTime();
  return Date.now();
}

/**
 * Age reference for a run: when it ended, else when it started. Returns null when neither
 * is parseable, which protects the row (we never delete evidence we cannot date).
 */
function ageTimestampOf(row: RetentionRunRow): number | null {
  for (const value of [row.endedAt, row.startedAt]) {
    if (value === null || value === undefined) continue;
    const parsed =
      value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Pure retention selection over run rows. Deterministic: terminal runs are ordered newest
 * first with the run id as the tie-break, so a sweep plan is reproducible in tests and logs.
 */
export function selectRetentionCandidates(
  runs: readonly RetentionRunRow[],
  options: RetentionSelectionOptions,
): RetentionSelection {
  const nowMs = nowMsOf(options.now);
  const days = Number.isFinite(options.days) ? Math.max(0, options.days) : 0;
  const keep = Number.isFinite(options.keep) ? Math.max(0, Math.trunc(options.keep)) : 0;
  const cutoff = nowMs - days * DAY_MS;

  const terminal: { id: string; at: number }[] = [];
  const protectedIds: string[] = [];

  for (const row of runs) {
    if (!isTerminal(row.status)) {
      protectedIds.push(row.id);
      continue;
    }
    const at = ageTimestampOf(row);
    if (at === null) {
      // An undatable row is protected rather than guessed at.
      protectedIds.push(row.id);
      continue;
    }
    terminal.push({ id: row.id, at });
  }

  terminal.sort((left, right) => {
    if (right.at !== left.at) return right.at - left.at;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  const kept = terminal.slice(0, keep).map((entry) => entry.id);
  const remove = terminal
    .slice(keep)
    .filter((entry) => entry.at < cutoff)
    .map((entry) => entry.id)
    .reverse(); // oldest first, so a sweep removes the least valuable evidence first

  return {
    scanned: runs.length,
    kept,
    protected: protectedIds,
    remove,
  };
}

/** Artifact storage keys recorded on a run row (deduped, blanks dropped). */
export function artifactKeysOf(row: RetentionRunRow | undefined): string[] {
  const artifacts = parseJsonb<RunArtifact[]>(row?.artifacts, []);
  const keys = new Set<string>();
  for (const artifact of artifacts) {
    const key = artifact?.storageKey;
    if (typeof key === 'string' && key.trim() !== '') keys.add(key);
  }
  return [...keys];
}

export interface SweepFactoryRetentionArgs {
  factory: string;
  /** Defaults to `loadConfig()`; the API passes its own resolved config. */
  config?: OrchestrationConfig;
  /** Manual override of the configured age window. */
  days?: number;
  /** Manual override of the configured keep count. */
  keep?: number;
  dryRun?: boolean;
  actor?: string;
  reason?: string;
  now?: Date | number;
  /** Injectable SQL client (tests / the API's singleton). */
  sql?: ReturnType<typeof getSql>;
  /** Injectable fetch for the signed DELETE (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable store; `null` disables blob deletion. Defaults to the configured store. */
  store?: S3ArtifactStore | null;
}

export interface RetentionCanaryTrees {
  kept: number;
  removed: number;
  protected: number;
}

export interface RetentionSweepResult {
  factory: string;
  dryRun: boolean;
  days: number;
  keep: number;
  scanned: number;
  /** Runs deleted; under `dryRun`, the runs that would be deleted. */
  removed: number;
  /** Ids deleted, or the plan under `dryRun`. */
  removedRunIds: string[];
  kept: number;
  protected: number;
  artifactsDeleted: number;
  artifactsFailed: number;
  runDirsRemoved: number;
  errors: string[];
  /** Terminal candidate-tree prune (skipped entirely under `dryRun`). */
  canaryTrees: RetentionCanaryTrees;
}

/**
 * Sweeps one factory: DB rows first, then `runs/<id>/`, then stored blobs, then terminal
 * canary trees. Returns counts plus per-step errors; a failure never aborts the rest of the
 * factory and never rolls back work that already succeeded.
 */
export async function sweepFactoryRetention(
  args: SweepFactoryRetentionArgs,
): Promise<RetentionSweepResult> {
  const config = args.config ?? loadConfig();
  const sql = args.sql ?? getSql();
  const factory = args.factory;

  const days = Math.max(0, args.days ?? config.retentionDays);
  const keep = Math.max(0, Math.trunc(args.keep ?? config.retentionKeepRuns));
  const dryRun = args.dryRun ?? config.retentionDryRun;
  const now = args.now;

  const rows = (await sql`
    select id, status, started_at, ended_at, artifacts
    from runs
    where factory = ${factory}
  `) as {
    id: string;
    status: string;
    started_at: string | Date | null;
    ended_at: string | Date | null;
    artifacts: unknown;
  }[];

  const normalized: RetentionRunRow[] = rows.map((row) => ({
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    artifacts: row.artifacts,
  }));
  const byId = new Map(normalized.map((row) => [row.id, row]));

  const selection = selectRetentionCandidates(normalized, { now, days, keep });

  // Capture storage keys before the metadata disappears.
  const artifactKeys = new Map<string, string[]>();
  for (const runId of selection.remove) {
    const keys = artifactKeysOf(byId.get(runId));
    if (keys.length > 0) artifactKeys.set(runId, keys);
  }

  const store =
    args.store !== undefined ? args.store : artifactStoreFromConfig(config.artifactStore);
  const fetchImpl = args.fetchImpl ?? fetch;

  const errors: string[] = [];
  const removedRunIds: string[] = [];
  let artifactsDeleted = 0;
  let artifactsFailed = 0;
  let runDirsRemoved = 0;

  for (const runId of selection.remove) {
    if (!dryRun) {
      try {
        await sql.begin(async (tx) => {
          // No FK cascade from `runs` for either table: delete them explicitly first.
          await tx`delete from run_secrets where run_id = ${runId}`;
          await tx`delete from score_runs where run_id = ${runId}`;
          await tx`delete from runs where id = ${runId}`;
        });
        removedRunIds.push(runId);
      } catch (error) {
        errors.push(`run ${runId}: ${messageOf(error)}`);
        continue; // keep the files: metadata still references them
      }

      const dir = runDir(config.runsDir, runId);
      if (existsSync(dir)) {
        try {
          rmSync(dir, { recursive: true, force: true });
          runDirsRemoved += 1;
        } catch (error) {
          errors.push(`run dir ${runId}: ${messageOf(error)}`);
        }
      }
    } else {
      removedRunIds.push(runId);
    }

    for (const key of artifactKeys.get(runId) ?? []) {
      if (dryRun) continue;
      if (!store) continue; // storage disabled: nothing to delete
      const deleted = await store.deleteStoredObject(key, fetchImpl);
      if (deleted) artifactsDeleted += 1;
      else artifactsFailed += 1;
    }
  }

  // Terminal canary trees are pruned after the run rows; a dry run deletes nothing.
  let canaryTrees: RetentionCanaryTrees = { kept: 0, removed: 0, protected: 0 };
  if (!dryRun) {
    try {
      const canary = await collectCanaryTrees(sql, {
        factory,
        keep: config.canaryKeepTrees,
        actor: args.actor ?? 'system',
        reason: args.reason ?? 'retention sweep',
      });
      canaryTrees = {
        kept: canary.kept.length,
        removed: canary.removed.length,
        protected: canary.protected.length,
      };
    } catch (error) {
      errors.push(`canary trees: ${messageOf(error)}`);
    }
  }

  return {
    factory,
    dryRun,
    days,
    keep,
    scanned: selection.scanned,
    removed: dryRun ? selection.remove.length : removedRunIds.length,
    removedRunIds,
    kept: selection.kept.length,
    protected: selection.protected.length,
    artifactsDeleted,
    artifactsFailed,
    runDirsRemoved,
    errors,
    canaryTrees,
  };
}

export interface SweepRetentionArgs {
  config?: OrchestrationConfig;
  sql?: ReturnType<typeof getSql>;
  now?: Date | number;
  fetchImpl?: typeof fetch;
}

export interface RetentionSweepSummary {
  factories: number;
  scanned: number;
  removed: number;
  kept: number;
  protected: number;
  artifactsDeleted: number;
  artifactsFailed: number;
  runDirsRemoved: number;
  errors: string[];
  dryRun: boolean;
  results: RetentionSweepResult[];
}

/**
 * Sweeps every factory with recorded runs, using the configured defaults. One factory's
 * failure is recorded and does not stop the others. Emits one structured log line.
 */
export async function sweepRetention(
  args: SweepRetentionArgs = {},
): Promise<RetentionSweepSummary> {
  const config = args.config ?? loadConfig();
  const sql = args.sql ?? getSql();

  const rows = (await sql`
    select distinct factory from runs order by factory
  `) as { factory: string }[];

  const summary: RetentionSweepSummary = {
    factories: rows.length,
    scanned: 0,
    removed: 0,
    kept: 0,
    protected: 0,
    artifactsDeleted: 0,
    artifactsFailed: 0,
    runDirsRemoved: 0,
    errors: [],
    dryRun: config.retentionDryRun,
    results: [],
  };

  for (const row of rows) {
    try {
      const result = await sweepFactoryRetention({
        config,
        factory: row.factory,
        sql,
        ...(args.now === undefined ? {} : { now: args.now }),
        ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
      });
      summary.results.push(result);
      summary.scanned += result.scanned;
      summary.removed += result.removed;
      summary.kept += result.kept;
      summary.protected += result.protected;
      summary.artifactsDeleted += result.artifactsDeleted;
      summary.artifactsFailed += result.artifactsFailed;
      summary.runDirsRemoved += result.runDirsRemoved;
      summary.errors.push(...result.errors);
    } catch (error) {
      summary.errors.push(`factory ${row.factory}: ${messageOf(error)}`);
    }
  }

  log('retention_sweep', {
    factories: summary.factories,
    dryRun: summary.dryRun,
    days: config.retentionDays,
    keep: config.retentionKeepRuns,
    scanned: summary.scanned,
    removed: summary.removed,
    kept: summary.kept,
    protected: summary.protected,
    artifactsDeleted: summary.artifactsDeleted,
    artifactsFailed: summary.artifactsFailed,
    runDirsRemoved: summary.runDirsRemoved,
    errors: summary.errors.length,
  });

  return summary;
}

/** Structured stdout log, matching the worker's JSON line format. */
function log(event: string, fields: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ level: 'info', event, ts: new Date().toISOString(), ...fields })}\n`,
  );
}
