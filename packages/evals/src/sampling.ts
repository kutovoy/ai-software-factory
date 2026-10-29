import { createHash } from 'node:crypto';

/**
 * Deterministic sampling, cadence and budget.
 *
 * Sampling is a stable hash of the run id, never a random draw: re-scoring the same run
 * selects the same runs, and a corpus can be frozen and replayed. A per-factory daily cap
 * bounds judge spend; deterministic scorers are free and never consume it.
 */

export function hashToBucket(runId: string): number {
  const digest = createHash('sha256').update(runId).digest();
  const value =
    (((digest[0] ?? 0) << 24) |
      ((digest[1] ?? 0) << 16) |
      ((digest[2] ?? 0) << 8) |
      (digest[3] ?? 0)) >>>
    0;
  return value;
}

/** `samplingRate` is a percentage: 0 never, 100 always, 25 ≈ one in four runs. */
export function isSampled(runId: string, samplingRate: number): boolean {
  if (samplingRate <= 0) return false;
  if (samplingRate >= 100) return true;
  return hashToBucket(runId) % 100 < samplingRate;
}

export function isWithinCadence(
  lastScoredAt: string | number | Date | null | undefined,
  cadenceMs: number,
  now = Date.now(),
): boolean {
  if (cadenceMs <= 0) return true;
  if (lastScoredAt === null || lastScoredAt === undefined) return true;
  const last =
    lastScoredAt instanceof Date
      ? lastScoredAt.getTime()
      : typeof lastScoredAt === 'number'
        ? lastScoredAt
        : Date.parse(lastScoredAt);
  if (Number.isNaN(last)) return true;
  return now - last >= cadenceMs;
}

export interface BudgetState {
  usedToday: number;
  maxPerDay: number;
  remaining: number;
}

export function budgetState(usedToday: number, maxPerDay: number): BudgetState {
  const used = Math.max(0, Math.trunc(usedToday));
  const max = Math.max(0, Math.trunc(maxPerDay));
  return { usedToday: used, maxPerDay: max, remaining: Math.max(0, max - used) };
}

export type SamplingSkipReason = 'sampled_out' | 'budget_exhausted' | 'cadence';

export interface SamplingDecision {
  selected: boolean;
  reason: SamplingSkipReason | null;
}

export interface JudgeSamplingInput {
  runId: string;
  samplingRate: number;
  usedToday: number;
  maxPerDay: number;
  /** Last judge score for this scorer, if any. */
  lastScoredAt: string | number | Date | null;
  cadenceMs: number;
  now?: number;
  /**
   * On-demand scoring of a specific run is an explicit human request: it bypasses the
   * sampling draw and the cadence, but never the daily budget.
   */
  force?: boolean;
}

/**
 * Decides whether a judge scorer runs for one run. Budget is checked first: no
 * configuration can spend past the cap. `force` then bypasses cadence + sampling.
 */
export function decideJudgeSampling(input: JudgeSamplingInput): SamplingDecision {
  const now = input.now ?? Date.now();
  if (input.maxPerDay <= 0 || input.usedToday >= input.maxPerDay) {
    return { selected: false, reason: 'budget_exhausted' };
  }
  if (input.force) return { selected: true, reason: null };
  if (!isWithinCadence(input.lastScoredAt, input.cadenceMs, now)) {
    return { selected: false, reason: 'cadence' };
  }
  if (!isSampled(input.runId, input.samplingRate)) {
    return { selected: false, reason: 'sampled_out' };
  }
  return { selected: true, reason: null };
}
