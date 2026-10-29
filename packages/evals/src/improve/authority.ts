import type { ImprovementDecision, ImprovementAuthority, BenchmarkNonRegressionEvidence } from './types';

/**
 * Authority routing (spec `self-improvement` › Authority levels, ADR-020/ADR-021).
 *
 * The authority is read from the definition. It decides *how* an accepted candidate lands:
 *  - `propose_only` always opens a PR and never merges;
 *  - `auto_merge_on_benchmark` merges only with a passing, calibrated benchmark attestation
 *    for the running commit + configuration hash and no probe regression, else opens a PR;
 *  - `canary` publishes the candidate as a candidate version and starts a rollout
 *    (`CanaryWorkflow`) that routes new work by a deterministic hash and observes it.
 */

export interface DecideImprovementInput {
  authority: ImprovementAuthority;
  /** True when probing produced at least one winning edit and a composed candidate. */
  hasCandidate: boolean;
  probe: {
    baselineScore: number | null;
    candidateScore: number | null;
    uncalibrated: boolean;
  } | null;
  benchmark: BenchmarkNonRegressionEvidence | null;
}

/** Historical code from Phase 5a; kept so old proposals still render. */
export const CANARY_NOT_AVAILABLE = 'canary_not_available';
export const CANARY_ROLLOUT = 'canary_rollout';

export function decideImprovement(input: DecideImprovementInput): ImprovementDecision {
  if (!input.hasCandidate || input.probe === null) {
    return {
      action: 'no_improvement',
      code: 'no_improvement',
      reason: 'no edit improved the contrastive signal; no candidate version was produced',
    };
  }

  const { probe, benchmark } = input;

  if (input.authority === 'canary') {
    return {
      action: 'canary',
      code: CANARY_ROLLOUT,
      reason:
        'authority is canary: the candidate is published as a candidate version and a rollout routes new work to it by deterministic hash while the observation window runs',
    };
  }

  if (input.authority === 'propose_only') {
    return {
      action: 'open_pr',
      code: 'propose_only',
      reason: 'authority is propose_only: the candidate is opened as a pull request and never merged automatically',
    };
  }

  // auto_merge_on_benchmark
  if (probe.uncalibrated) {
    return {
      action: 'open_pr',
      code: 'benchmark_uncalibrated',
      reason: 'a probe score came from an uncalibrated judge, so automatic merge is refused',
    };
  }
  if (
    probe.baselineScore !== null &&
    probe.candidateScore !== null &&
    probe.candidateScore < probe.baselineScore
  ) {
    return {
      action: 'open_pr',
      code: 'probe_regression',
      reason: 'the candidate regressed the contrastive probe, so automatic merge is refused',
    };
  }
  if (
    !benchmark ||
    !benchmark.attestationPassed ||
    !benchmark.attestationCalibrated ||
    !benchmark.commitMatches ||
    !benchmark.configHash
  ) {
    return {
      action: 'open_pr',
      code: 'benchmark_attestation_missing',
      reason:
        'no passing, calibrated benchmark attestation matches the running definition commit + configuration hash; a pull request is opened instead',
    };
  }

  return {
    action: 'merge',
    code: 'benchmark_non_regression',
    reason:
      'a passing, calibrated benchmark attestation matches the running version and the probe did not regress; the candidate is merged',
  };
}

/** Applies an improvement decision to the proposal status vocabulary. */
export function statusForDecision(action: ImprovementDecision['action']): string {
  switch (action) {
    case 'merge':
      return 'merged';
    case 'open_pr':
      return 'pr_open';
    case 'canary':
      return 'canary';
    case 'canary_not_available':
      return 'canary_not_available';
    case 'no_improvement':
      return 'no_improvement';
  }
}
