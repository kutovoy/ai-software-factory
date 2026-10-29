/**
 * Persistence shapes for benchmarks (ADR-010: plain SQL over Bun's `SQL` client).
 * The DB indexes benchmark runs; definitions and task files stay in git.
 */

export type BenchmarkRunStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled';
export type BenchmarkTrialStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped';

export interface BenchmarkRunRecord {
  id: string;
  factory: string;
  suite: string;
  definitionCommit: string;
  configHash: string;
  status: BenchmarkRunStatus;
  tasks: string[];
  configurations: string[];
  matrix: { configuration: string; task: string }[];
  estimateUsd: number | null;
  maxCostUsd: number;
  spentUsd: number;
  budgetExhausted: boolean;
  partial: boolean;
  passRate: number | null;
  calibrationOk: boolean;
  passed: boolean;
  error: string | null;
  workflowId: string | null;
  temporalRunId: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface BenchmarkTrialRecord {
  id: string;
  benchmarkRunId: string;
  factory: string;
  suite: string;
  configuration: string;
  task: string;
  runId: string | null;
  status: BenchmarkTrialStatus;
  errorCode: string | null;
  score: number | null;
  passing: boolean;
  costUsd: number;
  uncalibrated: boolean;
  startingRepoRefs: string[];
  repo: string | null;
  definitionCommit: string;
  configHash: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface BenchmarkResultRecord {
  benchmarkRunId: string;
  configuration: string;
  passRate: number | null;
  weightedScore: number | null;
  sampleSize: number;
  passingCount: number;
  costUsd: number;
  errors: number;
  skipped: number;
  uncalibrated: boolean;
  labels: string[];
  frontier: boolean;
  dominatedBy: string | null;
}

export interface BenchmarkAttestationRecord {
  id: string;
  factory: string;
  definitionCommit: string;
  suite: string;
  configHash: string;
  passRate: number | null;
  calibrationOk: boolean;
  passed: boolean;
  /** True when the attestation came from a partial (task/config subset) run. */
  partial: boolean;
  benchmarkRunId: string | null;
  createdAt: string | null;
}

export interface BenchmarkEventRecord {
  id: number;
  benchmarkRunId: string;
  factory: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string | null;
}
