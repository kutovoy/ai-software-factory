import { createHash } from 'node:crypto';

/**
 * Canary routing + observation (Phase 5b, ADR-021).
 *
 * Routing is a pure function of the work-item id so it is reproducible, testable and
 * immune to retries: an item is assigned exactly once, at creation, and every stage of
 * that item runs the same version. The observation comparison is a pure function too, so
 * the workflow, the API projection and the unit tests share one definition of
 * "regression".
 */

export type CanaryVersion = 'stable' | 'candidate';

export const CANARY_STABLE: CanaryVersion = 'stable';
export const CANARY_CANDIDATE: CanaryVersion = 'candidate';

/** `0..99` bucket of a work item id: sha256's first 32 bits, modulo 100. */
export function canaryBucket(workItemId: string): number {
  const digest = createHash('sha256').update(workItemId).digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * Deterministic assignment: the same id and percentage always produce the same version,
 * and `canaryPercent = 100` routes everything to the candidate.
 */
export function assignCanaryVersion(workItemId: string, canaryPercent: number): CanaryVersion {
  const percent = Math.max(0, Math.min(100, Math.trunc(canaryPercent)));
  return canaryBucket(workItemId) < percent ? CANARY_CANDIDATE : CANARY_STABLE;
}

/** Per-version evidence collected from the read model during the observation window. */
export interface CanaryVersionStats {
  version: CanaryVersion;
  /** Work items created during the window and routed to this version. */
  workItems: number;
  /** Scores recorded on this version's runs. */
  scores: number;
  passing: number;
  failing: number;
  /** Scores that errored (a scorer failure is an incident signal). */
  errors: number;
  /** `passing / scores`, null when there are no scores yet. */
  passRate: number | null;
  /** `errors / scores`, null when there are no scores yet. */
  errorRate: number | null;
  meanScore: number | null;
  /** Terminal runs on this version (any status). */
  runs: number;
  /** Runs that ended `error` or `cancelled`. */
  failedRuns: number;
  /** `failedRuns / runs`, null when there are no runs yet. */
  failureRate: number | null;
}

export interface CanaryObservation {
  stable: CanaryVersionStats;
  candidate: CanaryVersionStats;
  /** Allowed regression as a fraction (0..1). */
  threshold: number;
  /** `candidate.passRate - stable.passRate`, null when either side has no scores. */
  passRateDelta: number | null;
  /** `candidate.failureRate - stable.failureRate`, null when either side has no runs. */
  failureRateDelta: number | null;
  /** True when a regression beyond the threshold was observed. */
  regressionExceeded: boolean;
  /** Stable machine reason (`pass_rate_regression`, `incident_rate_regression`), else null. */
  reason: string | null;
  /** Human-readable explanation, recorded in the rollback event. */
  detail: string;
  /** True when the candidate has no evidence yet: no promotion can be evidence-based. */
  insufficientData: boolean;
  evidence: Record<string, unknown>;
}

export interface EvaluateCanaryInput {
  stable: CanaryVersionStats;
  candidate: CanaryVersionStats;
  threshold: number;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return round(numerator / denominator);
}

/** Builds an empty stats block (used when one side has no evidence yet). */
export function emptyCanaryStats(version: CanaryVersion): CanaryVersionStats {
  return {
    version,
    workItems: 0,
    scores: 0,
    passing: 0,
    failing: 0,
    errors: 0,
    passRate: null,
    errorRate: null,
    meanScore: null,
    runs: 0,
    failedRuns: 0,
    failureRate: null,
  };
}

/** Recomputes the derived rates of a stats block after counts were filled in. */
export function withRates(stats: CanaryVersionStats): CanaryVersionStats {
  return {
    ...stats,
    passRate: rate(stats.passing, stats.scores),
    errorRate: rate(stats.errors, stats.scores),
    failureRate: rate(stats.failedRuns, stats.runs),
  };
}

/**
 * Compares candidate against stable over the observation window.
 *
 * A regression is either a pass-rate drop or an incident-rate rise beyond the configured
 * threshold. `insufficientData` is reported separately: the caller may still promote at
 * the end of the window, but the evidence says no candidate score existed.
 */
export function evaluateCanaryObservation(input: EvaluateCanaryInput): CanaryObservation {
  const threshold = Math.max(0, Math.min(1, input.threshold));
  const stable = withRates(input.stable);
  const candidate = withRates(input.candidate);

  const passRateDelta =
    stable.passRate === null || candidate.passRate === null
      ? null
      : round(candidate.passRate - stable.passRate);

  const failureRateDelta =
    stable.failureRate === null || candidate.failureRate === null
      ? null
      : round(candidate.failureRate - stable.failureRate);

  let reason: string | null = null;
  let detail = 'no regression beyond the threshold was observed';

  if (passRateDelta !== null && passRateDelta < -threshold) {
    reason = 'pass_rate_regression';
    detail = `candidate pass rate ${candidate.passRate} is ${Math.abs(passRateDelta).toFixed(4)} below stable ${stable.passRate} (threshold ${threshold})`;
  } else if (failureRateDelta !== null && failureRateDelta > threshold) {
    reason = 'incident_rate_regression';
    detail = `candidate failure rate ${candidate.failureRate} is ${failureRateDelta.toFixed(4)} above stable ${stable.failureRate} (threshold ${threshold})`;
  }

  const insufficientData = candidate.scores === 0 && candidate.runs === 0;

  return {
    stable,
    candidate,
    threshold,
    passRateDelta,
    failureRateDelta,
    regressionExceeded: reason !== null,
    reason,
    detail,
    insufficientData,
    evidence: {
      threshold,
      stable: {
        workItems: stable.workItems,
        scores: stable.scores,
        passing: stable.passing,
        errors: stable.errors,
        passRate: stable.passRate,
        runs: stable.runs,
        failedRuns: stable.failedRuns,
        failureRate: stable.failureRate,
      },
      candidate: {
        workItems: candidate.workItems,
        scores: candidate.scores,
        passing: candidate.passing,
        errors: candidate.errors,
        passRate: candidate.passRate,
        runs: candidate.runs,
        failedRuns: candidate.failedRuns,
        failureRate: candidate.failureRate,
      },
      passRateDelta,
      failureRateDelta,
      insufficientData,
      reason,
      detail,
    },
  };
}
