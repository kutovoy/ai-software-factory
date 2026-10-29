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
