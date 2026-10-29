/**
 * Persistence shapes for scoring (ADR-010: plain SQL over Bun's `SQL` client).
 * The DB is a read model: definitions stay in git, scores are derived records.
 */

export type ScorerClass = 'deterministic' | 'judge';
export type ScoreStatus = 'ok' | 'error' | 'skipped';
export type ScoreTrigger = 'scheduled' | 'on_demand';
export type CalibrationVerdict = 'pass' | 'fail' | 'insufficient_data';

export interface ScorerLabelRecord {
  value: string;
  score: number;
  description?: string;
}

export interface ScorerDefinitionRecord {
  factory: string;
  name: string;
  scorerClass: ScorerClass;
  rubricHash: string;
  judgeModel: string;
  labels: ScorerLabelRecord[];
  passingScore: number;
  samplingRate: number;
  selfImprovement: boolean;
  checks: string[];
  body: string;
  definitionCommit: string | null;
  updatedAt: string | null;
}

export interface ScoreProvenance {
  judgeModel: string | null;
  judgeModelVersion: string | null;
  promptHash: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface ScoreEvidenceRecord {
  kind: string;
  ref: string;
  detail: Record<string, unknown>;
}

export interface ScoreEventRecord {
  id: number;
  scoreId: string;
  factory: string;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string | null;
}

export interface ScoreRecord {
  id: string;
  scoreRunId: string | null;
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
  uncalibrated: boolean;
  provenance: ScoreProvenance;
  createdAt: string | null;
  evidence?: ScoreEvidenceRecord[];
}

export interface ScoreRunRecord {
  id: string;
  factory: string;
  runId: string | null;
  workItemId: string | null;
  stage: string | null;
  trigger: ScoreTrigger;
  status: 'running' | 'completed' | 'error';
  scorers: number;
  scored: number;
  skipped: number;
  errored: number;
  budgetExhausted: boolean;
  windowDays: number | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface CalibrationSetRecord {
  id: string;
  factory: string;
  scorer: string;
  name: string;
  minSize: number;
  threshold: number;
  tolerance: number;
  createdAt: string | null;
}

export interface CalibrationItemRecord {
  id: number;
  setId: string;
  runId: string | null;
  workItemId: string | null;
  humanLabel: string;
  humanScore: number;
  notes: string | null;
  createdAt: string | null;
}

export interface CalibrationResultRecord {
  id: number;
  setId: string;
  factory: string;
  scorer: string;
  rubricHash: string;
  judgeModel: string;
  judgeModelVersion: string | null;
  sampleSize: number;
  agreementExact: number | null;
  agreementWithinTolerance: number | null;
  tolerance: number;
  threshold: number;
  confusion: Record<string, Record<string, number>>;
  verdict: CalibrationVerdict;
  createdAt: string | null;
}

export interface ScoreFilters {
  factory?: string;
  runId?: string;
  workItemId?: string;
  stage?: string;
  scorer?: string;
  /** Only scores created at/after this ISO timestamp. */
  since?: string;
  limit?: number;
  offset?: number;
}

/** The minimal row shape the pure aggregator needs. */
export interface ScoreAggregateRow {
  scorer: string;
  scorerClass: ScorerClass;
  status: ScoreStatus;
  score: number | null;
  passing: boolean;
  uncalibrated: boolean;
  costUsd: number | null;
}

export interface ScoreAggregate {
  scorer: string;
  scorerClass: ScorerClass;
  sampleCount: number;
  passingCount: number;
  passRate: number | null;
  weightedScore: number | null;
  errorCount: number;
  skippedCount: number;
  uncalibratedCount: number;
  costUsd: number;
  /** A judge aggregate can only satisfy a benchmark gate when calibrated. */
  benchmarkEligible: boolean;
}
