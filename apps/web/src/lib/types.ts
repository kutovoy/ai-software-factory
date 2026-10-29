/** Wire shapes returned by `apps/api`. Kept structural: no shared runtime types. */

export type RunStatus = 'pending' | 'running' | 'ok' | 'error' | 'cancelled';

export interface RunSummary {
  id: string;
  factory: string;
  definitionCommit: string;
  definitionDirty: boolean;
  harness: string;
  model: string | null;
  runner: string;
  kind: string;
  title: string | null;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface RunStep {
  step_id: string;
  kind: string;
  status: 'running' | 'ok' | 'error' | 'cancelled';
  detail: unknown;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface RunArtifact {
  path: string;
  bytes?: number;
  kind?: string;
  sha256?: string;
}

export interface PermissionRow {
  request_id: string;
  action: string;
  detail: unknown;
  decision: 'allow' | 'deny' | 'always' | null;
  requested_at: string;
  decided_at: string | null;
}

export interface RunRow {
  id: string;
  factory: string;
  definition_commit: string;
  definition_dirty: boolean;
  harness: string;
  model: string | null;
  runner: string;
  kind: string;
  title: string | null;
  input: unknown;
  status: RunStatus;
  workflow_id: string;
  temporal_run_id: string | null;
  session_ref: string | null;
  error: string | null;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  cost_usd: string | number | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  artifacts: unknown;
}

export interface RunDetail {
  /** Raw row (snake_case) as returned by the API. */
  run: RunRow;
  /** Camel-cased projection — prefer this for display fields. */
  summary: RunSummary;
  steps: RunStep[];
  artifacts: RunArtifact[] | null;
  permissions: PermissionRow[];
  pendingPermissions: PermissionRow[];
  proxyAttempts: unknown[];
}

export interface GateStage {
  stage: string;
  gate: string;
  source: 'automation' | 'factory' | 'global';
}

export interface GateResolution {
  stages: Record<string, GateStage>;
  mergePolicy: string;
  fullyAutonomous: boolean;
  benchmarkGateRequired: boolean;
}

export interface FactoryVersionSummary {
  commit: string;
  shortCommit: string;
  tag: string | null;
  contentHash: string | null;
  dirty: boolean | null;
}

export interface FactoryListItem {
  name: string;
  manifestName: string | null;
  alias: string | null;
  description: string | null;
  repoCount: number;
  resourceCount: number;
  valid: boolean;
  errorCount: number;
  version: FactoryVersionSummary | null;
}

export interface FactoryManifest {
  schemaVersion: string;
  name: string;
  alias?: string;
  description?: string;
  repositories: { owner: string; name: string }[];
  agentDefaults: {
    harness?: { type: string; model: string };
    model?: string;
    runner?: string;
  };
  gates: Record<string, string>;
  mergePolicy: string;
  secrets: string[];
  mcpServers?: Record<string, unknown>;
  integrations?: string[];
  selfImprovement?: {
    enabled: boolean;
    failedRunThreshold: number;
    reviewerType: string;
    requireBenchmarkWin: boolean;
  };
  improvement?: {
    authority: ImprovementAuthorityWire;
    canaryPercent?: number;
    rollbackThreshold?: number;
    observationWindowHours?: number;
    maxProbes?: number;
  };
}

export interface FactoryDetail {
  name: string;
  manifest: FactoryManifest;
  manifestName: string;
  alias: string | null;
  description: string | null;
  repoCount: number;
  resourceCount: number;
  version: FactoryVersionSummary | null;
  gates: GateResolution;
  fullyAutonomous: boolean;
  benchmarkGateRequired: boolean;
}

export interface ResourceSummary {
  kind: string;
  name: string;
  path: string;
  format: 'yaml' | 'markdown';
  summary: string;
  /** Normalised document as declared in git (schema defaults applied). */
  doc: unknown;
}

export interface FactoryResources {
  factory: string;
  counts: Record<string, number>;
  resources: ResourceSummary[];
}

export interface FactoryVersionEntry {
  commit: string;
  shortCommit: string;
  tag: string | null;
  date: string | null;
  message: string;
}

export interface DefinitionDiff {
  added: { kind: string; name: string }[];
  removed: { kind: string; name: string }[];
  changed: { kind: string; name: string; changes: { pointer: string; old: unknown; new: unknown }[] }[];
  isEmpty: boolean;
}

export interface FactoryDiff {
  factory: string;
  from: { commit: string | null; tag: string | null };
  to: { commit: string; tag: string | null };
  diff: DefinitionDiff;
  text: string;
}

/* ----------------------------------------------------------- work items */

/** Loop stages in board order (mirrors `LOOP_STAGES` in `@factory/core`). */
export const WORK_ITEM_STAGES = [
  'triage',
  'spec',
  'plan',
  'implement',
  'review',
  'verify',
  'ship',
] as const;

export type WorkItemStage = (typeof WORK_ITEM_STAGES)[number];

export interface WorkItemSummary {
  id: string;
  factory: string;
  type: string;
  source: string;
  sourceRef: Record<string, unknown>;
  title: string;
  stage: string;
  status: string;
  parentId: string | null;
  definitionCommit: string;
  /** Canary routing (ADR-021). */
  definitionVersion?: 'stable' | 'candidate';
  canaryRolloutId?: string | null;
  prUrl: string | null;
  prNumber: number | null;
  loopCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WorkItemEvent {
  id: number;
  workItemId: string;
  type: string;
  stage: string | null;
  actor: string | null;
  payload: Record<string, unknown>;
  createdAt: string | null;
}

export interface GateDecisionRecord {
  workItemId: string;
  stage: string;
  attempt: number;
  gate: string;
  workflowId: string | null;
  decision: 'approve' | 'reject' | 'request_changes' | null;
  actor: string | null;
  reason: string | null;
  feedback: string | null;
  automatic: boolean;
  requestedAt: string | null;
  slaAt: string | null;
  decidedAt: string | null;
}

export interface WorkItemDetail {
  workItem: WorkItemSummary;
  events: WorkItemEvent[];
  gates: GateDecisionRecord[];
  pendingGate: GateDecisionRecord | null;
  workflowId: string;
}

export interface CreatedWorkItem {
  workItem: WorkItemSummary;
  workflow: { workflowId: string; temporalRunId: string } | null;
}

export interface AutonomyState {
  factory: string;
  enabled: boolean;
  paused: boolean;
  actor: string | null;
  reason: string | null;
  overrideActor: string | null;
  overrideReason: string | null;
  benchmarkGateRequired: boolean;
  benchmarkGateSatisfied: boolean;
  benchmarkAttestationSatisfied?: boolean;
  benchmarkAttestationCode?: 'benchmark_attestation_missing' | null;
  signaled: number;
}

/* -------------------------------------------------------------- scoring */

export interface ScorerLabelWire {
  value: string;
  score: number;
  description?: string;
}

export interface CalibrationResultWire {
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
  verdict: 'pass' | 'fail' | 'insufficient_data';
  createdAt: string | null;
}

export interface ScorerApiEntry {
  name: string;
  path: string;
  description: string | null;
  body: string;
  scorerClass: 'deterministic' | 'judge';
  /** Wire alias for `scorerClass`. */
  class: 'deterministic' | 'judge';
  labels: ScorerLabelWire[];
  passingScore: number;
  samplingRate: number;
  judgeModel: string;
  selfImprovement: boolean;
  agents: string[];
  checks: string[];
  rubricHash: string;
  calibration: {
    required: boolean;
    calibrated: boolean;
    latest: CalibrationResultWire | null;
  };
}

export interface ScorersResponse {
  factory: string;
  scorers: ScorerApiEntry[];
  budget: { maxPerDay: number; usedToday: number; remaining: number };
  benchmarkGate: { required: boolean; satisfied: boolean; reason: string | null };
}

export interface ScoreEvidenceWire {
  kind: string;
  ref: string;
  detail: Record<string, unknown>;
}

export interface ScoreProvenanceWire {
  judgeModel: string | null;
  judgeModelVersion: string | null;
  promptHash: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface ScoreRecordWire {
  id: string;
  scoreRunId: string | null;
  factory: string;
  runId: string;
  workItemId: string | null;
  stage: string | null;
  scorer: string;
  scorerClass: 'deterministic' | 'judge';
  rubricHash: string;
  status: 'ok' | 'error' | 'skipped';
  errorCode: string | null;
  label: string | null;
  score: number | null;
  passing: boolean;
  rationale: string | null;
  evidenceRefs: string[];
  uncalibrated: boolean;
  provenance: ScoreProvenanceWire;
  createdAt: string | null;
  evidence?: ScoreEvidenceWire[];
}

export interface ScoreAggregateWire {
  scorer: string;
  scorerClass: 'deterministic' | 'judge';
  sampleCount: number;
  passingCount: number;
  passRate: number | null;
  weightedScore: number | null;
  errorCount: number;
  skippedCount: number;
  uncalibratedCount: number;
  costUsd: number;
  benchmarkEligible: boolean;
}

export interface ScoresResponse {
  scores: ScoreRecordWire[];
  aggregate: ScoreAggregateWire[];
}

export interface ScoreEventWire {
  id: number;
  scoreId: string;
  factory: string;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string | null;
}

export interface ScoreDetailResponse {
  score: ScoreRecordWire;
  evidence: ScoreEvidenceWire[];
  events: ScoreEventWire[];
  calibration: CalibrationResultWire | null;
}

export interface CalibrationItemWire {
  id: number;
  setId: string;
  runId: string | null;
  workItemId: string | null;
  humanLabel: string;
  humanScore: number;
  notes: string | null;
  createdAt: string | null;
}

export interface CalibrationSetWire {
  id: string;
  name: string;
  minSize: number;
  threshold: number;
  tolerance: number;
  itemCount: number;
  items: CalibrationItemWire[];
}

export interface CalibrationStatusResponse {
  factory: string;
  scorer: string;
  rubricHash: string;
  judgeModel: string;
  calibrated: boolean;
  latest: CalibrationResultWire | null;
  sets: CalibrationSetWire[];
  results: CalibrationResultWire[];
}

export interface CalibrationResponse {
  factory: string;
  scorer: string;
  setId: string;
  setName: string;
  rubricHash: string;
  judgeModel: string;
  judgeModelVersion: string | null;
  calibration: {
    status: 'ok' | 'insufficient_data';
    verdict: 'pass' | 'fail' | 'insufficient_data';
    sampleSize: number;
    minSize: number;
    agreementExact: number | null;
    agreementWithinTolerance: number | null;
    tolerance: number;
    threshold: number;
    confusion: Record<string, Record<string, number>>;
    reason?: string;
  };
  result: CalibrationResultWire;
  items: {
    item: CalibrationItemWire;
    judgeLabel: string | null;
    judgeScore: number | null;
    error: string | null;
  }[];
}

export interface MetricCardWire {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  sampleSize: number;
  definition: string;
  reason?: string;
}

export interface StageCostWire {
  stage: string;
  costUsd: number;
  runCount: number;
}

export interface FactoryMetricsResponse {
  factory: string;
  window: { from: string; to: string; days: number; label: string };
  metrics: MetricCardWire[];
  costByStage: StageCostWire[];
  unattributedCost: { costUsd: number; runCount: number };
  benchmarkGate: { required: boolean; satisfied: boolean; reason: string | null };
}

export interface StartScoringResponse {
  factory: string;
  trigger: 'on_demand';
  workflow: { workflowId: string; temporalRunId: string };
  runs: string[];
}

/* ----------------------------------------------------------- benchmarks */

export interface BenchmarkConfigurationWire {
  name: string;
  agents: { agent: string; model?: string; harness?: string }[];
}

export interface BenchmarkTaskWire {
  slug: string;
  path: string;
  title: string;
  prompt: string;
  successCriteria: string;
  startingRepoRefs: string[];
  tags: string[];
  sourceRunId: string | null;
}

export interface BenchmarkAttestationWire {
  id: string;
  factory: string;
  definitionCommit: string;
  suite: string;
  configHash: string;
  passRate: number | null;
  calibrationOk: boolean;
  passed: boolean;
  partial: boolean;
  benchmarkRunId: string | null;
  createdAt: string | null;
}

export interface BenchmarkSuiteEntryWire {
  name: string;
  path: string;
  description: string | null;
  agent: string;
  configurations: BenchmarkConfigurationWire[];
  tasks: BenchmarkTaskWire[];
  configHash: string;
  trialCount: number;
  attestation: BenchmarkAttestationWire | null;
}

export interface BenchmarkGateStatusWire {
  factory: string;
  definitionCommit: string;
  required: boolean;
  satisfied: boolean;
  code: 'benchmark_attestation_missing' | null;
  reason: string | null;
  suites: { suite: string; configHash: string; attestation: BenchmarkAttestationWire | null }[];
}

export interface BenchmarkRunWire {
  id: string;
  factory: string;
  suite: string;
  definitionCommit: string;
  configHash: string;
  status: 'queued' | 'running' | 'completed' | 'error' | 'cancelled';
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

export interface BenchmarkSuiteListResponse {
  factory: string;
  definitionCommit: string;
  definitionDirty: boolean;
  suites: BenchmarkSuiteEntryWire[];
  latestRun: BenchmarkRunWire | null;
  attestations: BenchmarkAttestationWire[];
  benchmarkGate: BenchmarkGateStatusWire;
}

export interface BenchmarkTrialWire {
  id: string;
  benchmarkRunId: string;
  factory: string;
  suite: string;
  configuration: string;
  task: string;
  runId: string | null;
  status: 'pending' | 'running' | 'ok' | 'error' | 'skipped';
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

export interface BenchmarkResultWire {
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

export interface BenchmarkAggregateWire {
  configurations: {
    configuration: string;
    passRate: number | null;
    weightedScore: number | null;
    sampleSize: number;
    passingCount: number;
    costUsd: number;
    errors: number;
    skipped: number;
    uncalibrated: boolean;
  }[];
  sampleSize: number;
  passingCount: number;
  passRate: number | null;
  weightedScore: number | null;
  costUsd: number;
  errors: number;
  skipped: number;
  uncalibrated: boolean;
  calibrationOk: boolean;
  passed: boolean;
  threshold: number;
}

export interface BenchmarkRunDetailResponse {
  benchmark: BenchmarkRunWire;
  trials: BenchmarkTrialWire[];
  results: BenchmarkResultWire[];
  events: { id: number; benchmarkRunId: string; factory: string; type: string; payload: Record<string, unknown>; createdAt: string | null }[];
  aggregate: BenchmarkAggregateWire;
  frontier: string[];
  labels: { highest_performance: string | null; most_efficient: string | null; lowest_cost: string | null };
  dominated: { configuration: string; by: string }[];
  recommendation: { configuration: string; reason: 'dominance' | 'only_configuration' } | null;
  recommendationReason: string | null;
  attestation: BenchmarkAttestationWire | null;
}

export interface BenchmarkEstimateWire {
  factory: string;
  suite: string;
  definitionCommit: string;
  configHash: string;
  configurations: string[];
  tasks: string[];
  trials: number;
  fullMatrix: boolean;
  estimate: {
    trials: number;
    medianRunCostUsd: number;
    estimateUsd: number;
    thresholdUsd: number;
    requiresConfirmation: boolean;
  };
}

export interface StartedBenchmarkWire {
  factory: string;
  suite: string;
  benchmark: BenchmarkRunWire;
  estimate: BenchmarkEstimateWire['estimate'];
  workflow: { workflowId: string; temporalRunId: string };
  trials: number;
}

export interface AttestationsResponse {
  factory: string;
  definitionCommit: string;
  attestations: BenchmarkAttestationWire[];
  benchmarkGate: BenchmarkGateStatusWire;
}

/* ------------------------------------------------------ self-improvement */

export type ImprovementAuthorityWire =
  | 'propose_only'
  | 'auto_merge_on_benchmark'
  | 'canary';

export interface ImprovementResolvedWire {
  authority: ImprovementAuthorityWire;
  canaryPercent: number | null;
  rollbackThreshold: number | null;
  observationWindowHours: number;
  maxProbes: number;
  source: 'declared' | 'default';
  canaryAvailable: boolean;
}

export interface ImprovementEligibilityWire {
  eligible: boolean;
  authority: ImprovementAuthorityWire;
  minScoredRuns: number;
  scoredRuns: number;
  calibratedJudges: string[];
  uncalibratedJudges: string[];
  reasons: string[];
}

export interface ImprovementRunWire {
  id: string;
  factory: string;
  definitionCommit: string;
  trigger: 'scheduled' | 'on_demand';
  status: 'queued' | 'running' | 'completed' | 'error' | 'skipped';
  authority: string;
  eligibility: Record<string, unknown>;
  proposals: number;
  lessons: number;
  decision: string | null;
  error: string | null;
  workflowId: string | null;
  temporalRunId: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ProposalEditWire {
  id: string;
  proposalId: string;
  kind: 'invariant' | 'domain';
  path: string;
  rationale: string;
  content: string;
  scope: 'in_scope' | 'out_of_scope';
  rejected: boolean;
  rejectionCode: string | null;
  contrast: Record<string, unknown> | null;
  createdAt: string | null;
}

export interface ProposalProbeWire {
  id: string;
  proposalId: string;
  editId: string;
  workItemId: string | null;
  runId: string | null;
  matchedInputs: Record<string, unknown>;
  baselineScore: number | null;
  candidateScore: number | null;
  delta: number | null;
  winner: boolean;
  createdAt: string | null;
}

export type ProposalStatusWire =
  | 'open'
  | 'accepted'
  | 'rejected'
  | 'no_improvement'
  | 'pr_open'
  | 'merged'
  | 'canary'
  | 'rolled_back'
  | 'canary_not_available'
  | 'failed';

export interface ProposalWire {
  id: string;
  improvementRunId: string | null;
  factory: string;
  kind: 'improvement' | 'authority_change';
  authority: string;
  status: ProposalStatusWire;
  title: string;
  summary: string;
  impact: number;
  evidence: Record<string, unknown>;
  failureSignature: string;
  files: string[];
  diff: { path: string; before: string; after: string }[];
  candidateHash: string | null;
  prUrl: string | null;
  prNumber: number | null;
  decisionActor: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  edits?: ProposalEditWire[];
  probes?: ProposalProbeWire[];
}

export interface LessonWire {
  id: string;
  factory: string;
  cue: string;
  lesson: string;
  evidence: Record<string, unknown>;
  confidence: number;
  proposalId: string | null;
  originFactory: string;
  promoted: boolean;
  promotedBy: string | null;
  promotedAt: string | null;
  createdAt: string | null;
}

export interface ImprovementOverviewWire {
  factory: string;
  definitionCommit: string;
  definitionDirty: boolean;
  authority: ImprovementAuthorityWire;
  resolved: ImprovementResolvedWire;
  eligibility: ImprovementEligibilityWire;
  lastRun: ImprovementRunWire | null;
  proposals: ProposalWire[];
  lessonCount: number;
  canary: {
    available: boolean;
    configuredPercent: number | null;
    rollbackThreshold: number | null;
    observationWindowHours: number;
    active: {
      rolloutId: string;
      status: CanaryStatusWire;
      candidateVersion: string;
      stableVersion: string;
      canaryPercent: number;
      startedAt: string | null;
      endsAt: string | null;
    } | null;
  };
}

/* ------------------------------------------------------ canary (Phase 5b) */

export type CanaryStatusWire = 'pending' | 'active' | 'promoted' | 'rolled_back' | 'unavailable';

export interface CanaryRolloutWire {
  id: string;
  factory: string;
  proposalId: string;
  candidateVersion: string;
  stableVersion: string;
  candidateCommit: string | null;
  stableCommit: string | null;
  candidateRoot: string | null;
  canaryPercent: number;
  rollbackThreshold: number;
  observationWindowHours: number;
  status: CanaryStatusWire;
  reason: string | null;
  prUrl: string | null;
  prNumber: number | null;
  actor: string | null;
  evidence: Record<string, unknown>;
  startedAt: string | null;
  endedAt: string | null;
}

export interface CanaryStatsWire {
  workItems: number;
  scores: number;
  passing: number;
  errors: number;
  passRate: number | null;
  meanScore: number | null;
  runs: number;
  failedRuns: number;
  failureRate: number | null;
}

export interface CanaryMetricsWire {
  rolloutId: string;
  status: string;
  reason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  canaryPercent: number;
  rollbackThreshold: number;
  observationWindowHours: number;
  stable: CanaryStatsWire;
  candidate: CanaryStatsWire;
  threshold: number;
  passRateDelta: number | null;
  failureRateDelta: number | null;
  regressionExceeded: boolean;
  regressionReason: string | null;
  detail: string;
  insufficientData: boolean;
  evidence: Record<string, unknown>;
}

export interface CanaryRolloutViewWire {
  rollout: CanaryRolloutWire;
  window: {
    startedAt: string | null;
    endsAt: string | null;
    elapsedMs: number;
    remainingMs: number;
    complete: boolean;
    observationWindowHours: number;
  };
  split: {
    canaryPercent: number;
    stablePercent: number;
    candidateItems: number;
    stableItems: number;
    totalItems: number;
  };
  metrics: CanaryMetricsWire | null;
  events: { type: string; payload: Record<string, unknown>; createdAt: string | null }[];
}

export interface CanaryOverviewWire {
  factory: string;
  definitionCommit: string;
  authority: ImprovementAuthorityWire;
  resolved: ImprovementResolvedWire;
  available: boolean;
  active: CanaryRolloutViewWire | null;
  history: CanaryRolloutViewWire[];
  proposals: ProposalWire[];
}

export interface ProposalDetailWire {
  proposal: ProposalWire;
  edits: ProposalEditWire[];
  probes: ProposalProbeWire[];
  events: { type: string; subject: string; payload: Record<string, unknown>; createdAt: string | null }[];
}

export interface StartedImprovementWire {
  factory: string;
  improvement: ImprovementRunWire;
  workflow: { workflowId: string; temporalRunId: string };
}

export interface AuthorityChangeWire {
  confirmationRequired: boolean;
  factory: string;
  from: ImprovementResolvedWire;
  to: ImprovementResolvedWire;
  diff: { pointer: string; old: unknown; new: unknown }[];
  text: string;
  proposal?: ProposalWire;
  prUrl?: string | null;
  prNumber?: number | null;
}
