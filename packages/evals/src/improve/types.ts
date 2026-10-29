/**
 * Self-improvement engine types (Phase 5).
 *
 * Everything here is plain data: no DB, no Temporal, no model. The observer, the probe,
 * the composer and the authority decision are deterministic functions shared by the
 * workflow, the API and the unit tests.
 */

export type ImprovementAuthority = 'propose_only' | 'auto_merge_on_benchmark' | 'canary';
export type ImprovementEditKind = 'invariant' | 'domain';

export type ScoredRunStatus = 'ok' | 'error' | 'cancelled';
export type ScoreStatusLike = 'ok' | 'error' | 'skipped';
export type ScorerClassLike = 'deterministic' | 'judge';

/** One score attached to a run in the observed corpus. */
export interface ScoreEvidence {
  scorer: string;
  scorerClass: ScorerClassLike;
  status: ScoreStatusLike;
  label: string | null;
  score: number | null;
  passing: boolean;
  errorCode: string | null;
  rationale: string | null;
  rubricHash: string;
  uncalibrated: boolean;
}

/** One scored run in the observed corpus. */
export interface ScoredRunEvidence {
  runId: string;
  workItemId: string | null;
  stage: string | null;
  /** Terminal run status; anything other than `ok` is a failure signal. */
  status: ScoredRunStatus;
  promptHash: string;
  costUsd: number;
  scores: ScoreEvidence[];
}

/* ------------------------------------------------------------ eligibility */

export interface JudgeCalibrationState {
  scorer: string;
  rubricHash: string;
  judgeModel: string;
  /** A passing calibration result exists for this rubric hash + judge model. */
  calibrated: boolean;
}

export interface EligibilityInput {
  authority: ImprovementAuthority;
  minScoredRuns: number;
  /** Distinct runs that carry at least one score. */
  scoredRuns: number;
  judges: JudgeCalibrationState[];
}

export interface EligibilityResult {
  eligible: boolean;
  authority: ImprovementAuthority;
  minScoredRuns: number;
  scoredRuns: number;
  calibratedJudges: string[];
  uncalibratedJudges: string[];
  reasons: string[];
}

/* --------------------------------------------------------------- observer */

/** A single file edit proposed by the observer. */
export interface ObservedEdit {
  kind: ImprovementEditKind;
  /** POSIX path relative to the definition root. */
  path: string;
  rationale: string;
  /** Full replacement file content (frontmatter + body for Markdown). */
  content: string;
}

export interface ObservedEvidence {
  runIds: string[];
  failedRuns: number;
  totalRuns: number;
  failureCount: number;
  costUsd: number;
  scorerRationales: { scorer: string; rationale: string }[];
}

export interface ObservedProposal {
  title: string;
  summary: string;
  /** Stable root-cause key: scorer/error/label + run status. */
  failureSignature: string;
  files: string[];
  edits: ObservedEdit[];
  evidence: ObservedEvidence;
  impact: number;
}

/* --------------------------------------------------------------- probe */

export interface ProbeWorkItem {
  workItemId: string | null;
  runId: string;
  promptHash: string;
  scorer: string;
  rubricHash: string;
}

export interface ProbeOutcome {
  status: string;
  score: number | null;
  passing: boolean;
  uncalibrated: boolean;
}

export interface ProbeResult {
  matchedInputs: Record<string, unknown>;
  baselineScore: number | null;
  candidateScore: number | null;
  delta: number;
  winner: boolean;
}

/* -------------------------------------------------------------- compose */

export interface CandidateDiffEntry {
  path: string;
  before: string;
  after: string;
}

export interface ComposedCandidate {
  /** Canonical serialized definition files with the winning edits applied. */
  files: { path: string; content: string }[];
  changedPaths: string[];
  diff: CandidateDiffEntry[];
  candidateHash: string;
}

/* ------------------------------------------------------------- authority */

export interface BenchmarkNonRegressionEvidence {
  /** A passing attestation for the current definition commit + config hash. */
  attestationPassed: boolean;
  attestationCalibrated: boolean;
  /** The attestation's definition commit equals the running commit. */
  commitMatches: boolean;
  configHash: string | null;
}

export type ImprovementDecisionAction =
  | 'open_pr'
  | 'merge'
  | 'canary_not_available'
  | 'no_improvement';

export interface ImprovementDecision {
  action: ImprovementDecisionAction;
  /** Stable machine reason (`benchmark_attestation_missing`, `probe_regression`, ...). */
  code: string;
  reason: string;
  /** Phase flag for the deferred canary rollout (Phase 5b). */
  phase?: '5b';
}
