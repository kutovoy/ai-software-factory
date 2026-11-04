/**
 * Scorer and measurement types shared by the evals package, the orchestration
 * activities and the API. Nothing here imports a runtime: the shapes are plain data.
 */

export type ScorerClass = 'deterministic' | 'judge';

/** Checks graded from a run's command evidence. */
export const COMMAND_CHECKS = ['tests', 'build', 'lint'] as const;
/** Checks graded from the run trace (events + gate verdicts). */
export const TRACE_CHECKS = ['redundant_tests', 'verbosity', 'scope', 'review_usefulness'] as const;
export const DETERMINISTIC_CHECKS = [...COMMAND_CHECKS, ...TRACE_CHECKS] as const;
export type CommandCheck = (typeof COMMAND_CHECKS)[number];
export type TraceCheck = (typeof TRACE_CHECKS)[number];
export type DeterministicCheck = (typeof DETERMINISTIC_CHECKS)[number];

export interface ScorerLabel {
  value: string;
  score: number;
  description?: string;
}

/** One registered scorer, derived from the git-backed definition. */
export interface ScorerRegistryEntry {
  name: string;
  /** POSIX path relative to the definition root (`scorers/scope/scorer.md`). */
  path: string;
  description: string | null;
  /** Normalised rubric body (the prose after the frontmatter). */
  body: string;
  scorerClass: ScorerClass;
  labels: ScorerLabel[];
  passingScore: number;
  samplingRate: number;
  judgeModel: string;
  selfImprovement: boolean;
  agents: string[];
  /** Empty for judge scorers; the checks a deterministic scorer evaluates. */
  checks: DeterministicCheck[];
  /** sha256 over the rubric body + label set. Content-addressed. */
  rubricHash: string;
}

export class ScorerRegistryError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ScorerRegistryError';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------- run evidence */

export interface RunArtifactRef {
  path: string;
  kind?: string;
  bytes?: number;
}

export interface ToolCallEvidence {
  name: string;
  /** Reconstructed command line, when the harness streamed JSON args. */
  command?: string;
  ok: boolean;
  /** Event seq the completion was recorded at. */
  seq: number;
}

export interface TraceUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cacheReadTokens: number;
  reasoningTokens: number;
}

export interface TraceMessages {
  assistantMessages: number;
  assistantChars: number;
  finalSummaryChars: number;
}

export interface TraceFileEdit {
  path: string;
  diffBytes: number;
  addedLines: number;
  removedLines: number;
}

export interface TraceReview {
  verdict: string | null;
  findings: number;
  summaryChars: number;
}

/**
 * Deterministic trace metrics for one run. These are derived from the canonical event
 * log and the gate verdict, never from a model, so they can be used by scoring and by
 * evidence-backed self-improvement proposals.
 */
export interface TraceMetrics {
  toolCalls: number;
  failedToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  assistantMessages: number;
  assistantChars: number;
  finalSummaryChars: number;
  fileEdits: number;
  changedFiles: number;
  patchBytes: number;
  testCommands: number;
  redundantTestCommands: number;
  reviewFindings: number;
  reviewSummaryChars: number;
}

/** The neutral, model-free view of a run used by deterministic scorers. */
export interface RunEvidence {
  artifacts: RunArtifactRef[];
  /** Small artifact bodies (e.g. `artifacts/checks.json`), keyed by POSIX path. */
  artifactContents: Record<string, string>;
  toolCalls: ToolCallEvidence[];
  usage: TraceUsage | null;
  messages: TraceMessages | null;
  fileEdits: TraceFileEdit[];
  patchBytes: number;
  review: TraceReview | null;
}

export interface ScoreEvidenceRef {
  kind: 'event' | 'artifact' | 'work_item' | 'forge' | 'run';
  ref: string;
  detail?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ drafts */

export interface JudgeProvenance {
  judgeModel: string;
  judgeModelVersion: string | null;
  rubricHash: string;
  promptHash: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export type ScoreStatus = 'ok' | 'error' | 'skipped';

/**
 * A score computed by an activity but not yet persisted. `persistScore` assigns the
 * stable id, checks calibration and writes the append-only event.
 */
export interface ScoreDraft {
  factory: string;
  runId: string;
  workItemId: string | null;
  stage: string | null;
  scorer: string;
  scorerClass: ScorerClass;
  rubricHash: string;
  status: ScoreStatus;
  errorCode: string | null;
  label: string | null;
  score: number | null;
  passing: boolean;
  rationale: string | null;
  evidenceRefs: string[];
  evidence: ScoreEvidenceRef[];
  uncalibrated: boolean;
  provenance: JudgeProvenance | null;
}

/* ------------------------------------------------------------- calibration */

export interface CalibrationItemObservation {
  humanLabel: string;
  humanScore: number;
  judgeLabel: string | null;
  judgeScore: number | null;
}

export interface CalibrationComputation {
  status: 'ok' | 'insufficient_data';
  verdict: 'pass' | 'fail' | 'insufficient_data';
  sampleSize: number;
  minSize: number;
  agreementExact: number | null;
  agreementWithinTolerance: number | null;
  tolerance: number;
  threshold: number;
  /** human label -> judge label -> count. */
  confusion: Record<string, Record<string, number>>;
  reason?: string;
}

export interface CalibrationResultLike {
  rubricHash: string;
  judgeModel: string;
  verdict: string;
}
