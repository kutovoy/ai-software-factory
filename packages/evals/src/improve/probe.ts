import type { ImprovementEditKind, ProbeOutcome, ProbeResult, ProbeWorkItem } from './types';

/**
 * Contrastive probe (spec `self-improvement` › Contrastive probe).
 *
 * A candidate edit is judged by re-running the *same* work item under matched inputs and
 * comparing the outcome with the baseline. Nothing here calls a model: the probe runner is
 * an injected hook (the deterministic hook is used in tests and smoke), so the arithmetic
 * and the matched-input guarantee are shared by every caller.
 */

export type ProbeErrorCode = 'probe_input_mismatch' | 'probe_missing_baseline';

export class ProbeError extends Error {
  readonly code: ProbeErrorCode;

  constructor(code: ProbeErrorCode, message: string) {
    super(message);
    this.name = 'ProbeError';
    this.code = code;
  }
}

/** Identity carried by both sides of a probe: same item, same inputs, same scorer. */
export interface ProbeIdentity {
  workItemId: string | null;
  runId: string;
  promptHash: string;
  scorer: string;
  rubricHash: string;
}

export interface ProbeSide extends ProbeOutcome {
  identity: ProbeIdentity;
}

export interface ContrastiveProbeInput {
  edit: { kind: ImprovementEditKind; path: string };
  workItem: ProbeWorkItem;
  baseline: ProbeSide;
  candidate: ProbeSide;
}

function assertMatched(input: ContrastiveProbeInput): void {
  const expected = input.workItem;
  for (const side of [input.baseline, input.candidate]) {
    const identity = side.identity;
    if (
      identity.workItemId !== expected.workItemId ||
      identity.runId !== expected.runId ||
      identity.promptHash !== expected.promptHash ||
      identity.scorer !== expected.scorer ||
      identity.rubricHash !== expected.rubricHash
    ) {
      throw new ProbeError(
        'probe_input_mismatch',
        `probe for ${input.edit.path} did not run the same work item under matched inputs (${expected.runId})`,
      );
    }
  }
}

/** Records the per-edit outcome difference; a strictly positive delta wins. */
export function runContrastiveProbe(input: ContrastiveProbeInput): ProbeResult {
  assertMatched(input);
  const baselineScore = input.baseline.score;
  const candidateScore = input.candidate.score;
  const delta = (candidateScore ?? 0) - (baselineScore ?? 0);
  return {
    matchedInputs: {
      workItemId: input.workItem.workItemId,
      runId: input.workItem.runId,
      promptHash: input.workItem.promptHash,
      scorer: input.workItem.scorer,
      rubricHash: input.workItem.rubricHash,
      editPath: input.edit.path,
      editKind: input.edit.kind,
    },
    baselineScore,
    candidateScore,
    delta: Math.round(delta * 1_000) / 1_000,
    winner: delta > 0,
  };
}

export interface ProbeRunnerArgs {
  edit: { kind: ImprovementEditKind; path: string };
  workItem: ProbeWorkItem;
  baseline: ProbeSide;
}

/**
 * The deterministic probe hook. It models a candidate re-run as a fixed improvement over
 * the baseline (an invariant guardrail is general, so it helps a little more than a
 * repo-specific rubric tweak). No model, no network, stable across retries.
 */
export type ProbeRunner = (args: ProbeRunnerArgs) => ProbeOutcome & { identity: ProbeIdentity };

export function createDeterministicProbeRunner(): ProbeRunner {
  return ({ edit, workItem, baseline }) => {
    const base = baseline.score ?? (baseline.passing ? 1 : 0);
    const bonus = edit.kind === 'invariant' ? 0.25 : 0.15;
    const score = Math.round(Math.min(1, base + bonus) * 1_000) / 1_000;
    return {
      identity: {
        workItemId: workItem.workItemId,
        runId: workItem.runId,
        promptHash: workItem.promptHash,
        scorer: workItem.scorer,
        rubricHash: workItem.rubricHash,
      },
      status: 'ok',
      score,
      passing: score >= 0.5,
      uncalibrated: baseline.uncalibrated,
    };
  };
}

/** A run that never produced a score is a baseline of zero, not a fabricated pass. */
export function baselineSide(
  identity: ProbeIdentity,
  outcome: { status: string; score: number | null; passing: boolean; uncalibrated: boolean },
): ProbeSide {
  return { identity, ...outcome };
}
