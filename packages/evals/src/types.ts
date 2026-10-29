/**
 * Scorer and measurement types shared by the evals package, the orchestration
 * activities and the API. Nothing here imports a runtime: the shapes are plain data.
 */

export type ScorerClass = 'deterministic' | 'judge';

export const DETERMINISTIC_CHECKS = ['tests', 'build', 'lint'] as const;
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

/** The neutral, model-free view of a run used by deterministic scorers. */
export interface RunEvidence {
  artifacts: RunArtifactRef[];
  /** Small artifact bodies (e.g. `artifacts/checks.json`), keyed by POSIX path. */
  artifactContents: Record<string, string>;
  toolCalls: ToolCallEvidence[];
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
