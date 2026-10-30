import {
  emptyCanaryStats,
  evaluateCanaryObservation,
  withRates,
  type CanaryVersionStats,
} from '@factory/core';
import { getSql } from './db';
import type {
  CanaryObservationSummary,
  CanarySeriesBucket,
  CanarySeriesSummary,
  CanaryStatsSummary,
} from './types';

/**
 * Canary observation (Phase 5b, ADR-021).
 *
 * Reads the read model over the rollout window and compares the candidate against stable:
 *  - scores: pass rate + scorer errors, grouped by the run's pinned `definitionCommit`
 *    (candidate work items run the candidate commit, stable items the stable commit);
 *  - runs: failure rate (error/cancelled), the "incidents" half of the comparison;
 *  - work items: how many items were actually routed to each side.
 *
 * No model, no network: the numbers are whatever the read model already holds.
 */

interface VersionCountsRow {
  definition_version: string;
  items: number | string;
}

interface ScoreAggregateRow {
  definition_commit: string;
  scores: number | string;
  passing: number | string;
  errors: number | string;
  mean_score: number | string | null;
}

interface RunAggregateRow {
  definition_commit: string;
  runs: number | string;
  failed: number | string;
}

export interface CanaryObservationArgs {
  factory: string;
  rolloutId: string;
  stableCommit: string;
  candidateCommit: string | null;
  startedAt: string | null;
  until?: string | null;
  rollbackThreshold: number;
  canaryPercent: number;
  observationWindowHours: number;
}

export async function readCanaryObservation(
  args: CanaryObservationArgs,
): Promise<CanaryObservationSummary> {
  const sql = getSql();
  const from = args.startedAt ?? new Date(0).toISOString();
  const until = args.until ?? null;

  const itemRows = (await sql`
      select definition_version, count(*) as items
      from work_items
      where factory = ${args.factory}
        and (
          canary_rollout_id = ${args.rolloutId}
          or (definition_version = 'stable' and canary_rollout_id is null)
        )
        and created_at >= ${from}::timestamptz
        and (${until}::timestamptz is null or created_at <= ${until}::timestamptz)
      group by definition_version
    `) as VersionCountsRow[];

  const scoreRows = (await sql`
      select r.definition_commit,
             count(s.id) as scores,
             count(s.id) filter (where s.passing) as passing,
             count(s.id) filter (where s.status = 'error') as errors,
             avg(s.score) as mean_score
      from scores s
      join runs r on r.id = s.run_id
      where s.factory = ${args.factory}
        and r.started_at >= ${from}::timestamptz
        and (${until}::timestamptz is null or r.started_at <= ${until}::timestamptz)
      group by r.definition_commit
    `) as ScoreAggregateRow[];

  const runRows = (await sql`
      select definition_commit,
             count(*) as runs,
             count(*) filter (where status in ('error', 'cancelled')) as failed
      from runs
      where factory = ${args.factory}
        and started_at >= ${from}::timestamptz
        and (${until}::timestamptz is null or started_at <= ${until}::timestamptz)
      group by definition_commit
    `) as RunAggregateRow[];

  const itemsFor = (version: 'stable' | 'candidate'): number => {
    const row = itemRows.find((entry) => entry.definition_version === version);
    return Number(row?.items ?? 0);
  };

  const statsFor = (version: 'stable' | 'candidate', commit: string | null): CanaryVersionStats => {
    if (!commit) return emptyCanaryStats(version);
    const scores = scoreRows.find((row) => row.definition_commit === commit);
    const runs = runRows.find((row) => row.definition_commit === commit);
    const total = Number(scores?.scores ?? 0);
    const passing = Number(scores?.passing ?? 0);
    const mean = scores?.mean_score === null || scores?.mean_score === undefined
      ? null
      : Number(scores.mean_score);
    return withRates({
      version,
      workItems: itemsFor(version),
      scores: total,
      passing,
      failing: Math.max(0, total - passing),
      errors: Number(scores?.errors ?? 0),
      passRate: null,
      errorRate: null,
      meanScore: mean === null ? null : Math.round(mean * 10_000) / 10_000,
      runs: Number(runs?.runs ?? 0),
      failedRuns: Number(runs?.failed ?? 0),
      failureRate: null,
    });
  };

  const stable = statsFor('stable', args.stableCommit);
  const candidate = statsFor('candidate', args.candidateCommit);
  const observation = evaluateCanaryObservation({
    stable,
    candidate,
    threshold: args.rollbackThreshold,
  });

  const summary = (stats: CanaryVersionStats): CanaryStatsSummary => ({
    workItems: stats.workItems,
    scores: stats.scores,
    passing: stats.passing,
    errors: stats.errors,
    passRate: stats.passRate,
    meanScore: stats.meanScore,
    runs: stats.runs,
    failedRuns: stats.failedRuns,
    failureRate: stats.failureRate,
  });

  return {
    rolloutId: args.rolloutId,
    status: 'active',
    reason: null,
    startedAt: args.startedAt,
    endedAt: null,
    canaryPercent: args.canaryPercent,
    rollbackThreshold: args.rollbackThreshold,
    observationWindowHours: args.observationWindowHours,
    stable: summary(observation.stable),
    candidate: summary(observation.candidate),
    threshold: observation.threshold,
    passRateDelta: observation.passRateDelta,
    failureRateDelta: observation.failureRateDelta,
    regressionExceeded: observation.regressionExceeded,
    regressionReason: observation.reason,
    detail: observation.detail,
    insufficientData: observation.insufficientData,
    evidence: observation.evidence,
  };
}

/* ------------------------------------------------------------- time series */

interface SeriesRow {
  bucket_ms: number | string;
  definition_commit: string;
  runs: number | string;
  failed_runs: number | string;
  scores: number | string;
  passing: number | string;
}

export interface CanarySeriesArgs {
  factory: string;
  rolloutId: string;
  stableCommit: string;
  candidateCommit: string | null;
  startedAt: string | null;
  until?: string | null;
  /** Bucket width; hourly is the contract (task 5.2). */
  bucketHours?: number;
}

const HOUR_MS = 60 * 60 * 1000;

function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * Hourly rollout series (task 5.2), derived from `scores` + `runs` (no new table).
 *
 * Every bucket in the window is present for both versions; a bucket with no runs is
 * `null` with `reason: no_runs_in_bucket`, never zero, so the chart can show a gap
 * instead of interpolating missing data as "0% passing".
 */
export async function readCanarySeries(args: CanarySeriesArgs): Promise<CanarySeriesSummary> {
  const sql = getSql();
  const bucketHours = Math.max(1, args.bucketHours ?? 1);
  const fromMs = floorHour(
    args.startedAt ? Date.parse(args.startedAt) || Date.now() : Date.now(),
  );
  const untilMs = args.until ? Date.parse(args.until) || Date.now() : Date.now();
  const toMs = Math.max(fromMs + bucketHours * HOUR_MS, floorHour(untilMs) + HOUR_MS);
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();

  const rows = (await sql`
    select
      (extract(epoch from date_trunc('hour', r.started_at)) * 1000)::bigint as bucket_ms,
      r.definition_commit,
      count(distinct r.id) as runs,
      count(distinct r.id) filter (where r.status in ('error', 'cancelled')) as failed_runs,
      count(s.id) as scores,
      count(s.id) filter (where s.passing) as passing
    from runs r
    left join scores s on s.run_id = r.id and s.factory = ${args.factory}
    where r.factory = ${args.factory}
      and r.started_at >= ${from}::timestamptz
      and r.started_at < ${to}::timestamptz
      and r.definition_commit in (${args.stableCommit}, ${args.candidateCommit ?? args.stableCommit})
    group by 1, 2
    order by 1 asc
  `) as SeriesRow[];

  const buckets: CanarySeriesBucket[] = [];
  const versions: ('stable' | 'candidate')[] = ['stable', 'candidate'];
  for (const version of versions) {
    const commit = version === 'stable' ? args.stableCommit : args.candidateCommit;
    for (let start = fromMs; start < toMs; start += bucketHours * HOUR_MS) {
      const bucketStart = new Date(start).toISOString();
      const bucketEnd = new Date(Math.min(start + bucketHours * HOUR_MS, toMs)).toISOString();
      const row = commit
        ? rows.find(
            (entry) =>
              entry.definition_commit === commit &&
              Number(entry.bucket_ms) === start,
          )
        : undefined;
      const runs = Number(row?.runs ?? 0);
      const failedRuns = Number(row?.failed_runs ?? 0);
      const scores = Number(row?.scores ?? 0);
      const passing = Number(row?.passing ?? 0);
      const passRate = scores > 0 ? Math.round((passing / scores) * 10_000) / 10_000 : null;
      const errorRate = runs > 0 ? Math.round((failedRuns / runs) * 10_000) / 10_000 : null;
      buckets.push({
        bucketStart,
        bucketEnd,
        version,
        scores,
        passing,
        passRate,
        runs,
        failedRuns,
        errorRate,
        reason:
          runs === 0
            ? 'no_runs_in_bucket'
            : scores === 0
              ? 'no_scores_in_bucket'
              : null,
      });
    }
  }

  return {
    rolloutId: args.rolloutId,
    bucketHours,
    from,
    to,
    stable: buckets.filter((bucket) => bucket.version === 'stable'),
    candidate: buckets.filter((bucket) => bucket.version === 'candidate'),
  };
}
