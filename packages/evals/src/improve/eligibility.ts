import type { EligibilityInput, EligibilityResult } from './types';

/**
 * Eligibility for an improvement run.
 *
 * Two gates, both evidence-based:
 *  - enough distinct scored runs to observe a pattern (not a single fluke);
 *  - every judge that produced scores is calibrated for its current rubric hash.
 *
 * An uncalibrated judge makes its scores an opinion, so a proposal built on them would be
 * self-reinforcing drift. Deterministic scorers are always trustworthy.
 */

export const DEFAULT_MIN_SCORED_RUNS = 3;

export function assessEligibility(input: EligibilityInput): EligibilityResult {
  const calibratedJudges = input.judges
    .filter((judge) => judge.calibrated)
    .map((judge) => judge.scorer);
  const uncalibratedJudges = input.judges
    .filter((judge) => !judge.calibrated)
    .map((judge) => judge.scorer);

  const reasons: string[] = [];
  if (input.scoredRuns < input.minScoredRuns) reasons.push('insufficient_scored_runs');
  if (input.judges.length > 0 && calibratedJudges.length === 0) reasons.push('no_calibrated_judges');
  if (uncalibratedJudges.length > 0) reasons.push('uncalibrated_judges');

  // Any uncalibrated judge blocks the loop: its scores cannot justify an edit.
  const eligible =
    input.scoredRuns >= input.minScoredRuns &&
    (input.judges.length === 0 || uncalibratedJudges.length === 0);

  return {
    eligible,
    authority: input.authority,
    minScoredRuns: input.minScoredRuns,
    scoredRuns: input.scoredRuns,
    calibratedJudges,
    uncalibratedJudges,
    reasons,
  };
}
