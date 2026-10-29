import {
  emptyCanaryStats,
  evaluateCanaryObservation,
  withRates,
  type CanaryVersionStats,
} from '@factory/core';
import { getSql } from './db';
import type { CanaryObservationSummary, CanaryStatsSummary } from './types';

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
