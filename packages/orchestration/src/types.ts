/**
 * Workflow-safe types. Nothing in this file may import Node APIs or Temporal worker
 * packages: it is bundled into the deterministic workflow sandbox.
 */

import type { AgentVerdict, AgentVerdictPolicy } from '@factory/core/gates/verdict';

export type RunStatus = 'pending' | 'running' | 'ok' | 'error' | 'cancelled';
export type TerminalStatus = 'ok' | 'error' | 'cancelled';
export type HarnessId =
  | 'opencode'
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'generic-cli'
  | 'fake';

export type RunnerKindName = 'local-docker' | 'local-process' | 'fake';

export interface RunPrompt {
  text: string;
  files?: string[];
}

/** Everything a run needs, resolved and pinned by the API before the workflow starts. */
export interface RunInput {
  runId: string;
  /** Factory name as declared in `factory.yaml`. */
  factory: string;
  /** Absolute path of the definition directory on the worker host. */
  factoryRoot: string;
  /** Pinned git commit of the definition (ADR-003). */
  definitionCommit: string;
  definitionDirty: boolean;
  harness: HarnessId;
  model?: string;
  agent?: string;
  runner: RunnerKindName;
  repo?: { path?: string; url?: string; commit?: string };
  /**
   * Run whose `patch.diff` is applied to this run's workspace after checkout. Set on
   * stages that must see an upstream stage's change (review/verify run on the implement
   * patch); absent for the first stage of a loop.
   */
  patchRunId?: string;
  /** First human message. Chat and factory runs share this field (ADR-002). */
  prompt: RunPrompt | null;
  kind: 'chat' | 'run';
  title?: string;
  /** Models this run may call through the inference proxy. Empty/absent → no proxy. */
  proxyModels: string[];
  /** Scripted adapter step delay; lets tests kill the worker mid-run. */
  fakeDelayMs?: number;
  /** Set when this run was created by retrying another run (retry-as-new-run). */
  retryOf?: string;
  workspace?: string;
  /** Setup commands from the definition's runner resource (executed inside the sandbox). */
  setupCommands?: string[];
  /**
   * SLA for a `permission.requested` wait (ADR-013). The wait itself is a workflow-level
   * durable wait with no activity cost; this timer only escalates (auto-deny + error).
   */
  permissionTimeoutMs?: number;
  /**
   * Factory stage runs are unattended agents: a harness permission request is answered
   * `allow` immediately instead of parking on a human. Chat runs stay interactive, so the
   * ADR-013 durable wait is unchanged for humans.
   */
  autoAllowPermissions?: boolean;
  /**
   * Benchmark trials are hermetic (Phase 4b): a fresh sandbox, a fresh fake-forge repo,
   * and no network by default. Recorded on the run so the inputs are re-runnable.
   */
  hermetic?: boolean;
  networkPolicy?: 'denied' | 'allowed';
  /**
   * Replay this recorded run (`runs/<replayFrom>/events.jsonl` + `patch.diff`) instead of
   * driving a harness: the adapter re-emits the recorded canonical events and applies the
   * recorded patch to this run's fresh workspace. No model call, no proxy token
   * (spec `benchmark-replay`).
   */
  replayFrom?: string;
}

export interface LeaseInfo {
  runnerId: string;
  kind: 'docker' | 'local';
  workspace: string;
  harnessUrl?: string;
  /** True when the run uses the in-process scripted adapter (no sandbox process). */
  ephemeral: boolean;
  /** Local sandbox state (ADR-025 / harden-runners); absent for docker/ephemeral leases. */
  sandbox?: { mode: 'exec' | 'bwrap' | 'none'; active: boolean; reason: string | null };
}

export interface ProxyCredentials {
  token: string;
  tokenId: string;
  baseUrl: string;
  models: string[];
}

export interface HarnessStartInfo {
  sessionRef?: string;
  harnessUrl?: string;
  /** Serialised capabilities, so the API can degrade without knowing the adapter. */
  capabilities: {
    streaming: boolean;
    toolCalls: boolean;
    permissions: 'interactive' | 'static' | 'none';
    resume: boolean;
    fork: boolean;
    usage: boolean;
    structuredOutput: boolean;
    /** True when the harness hosts MCP servers; false = wiring recorded only. */
    mcp: boolean;
  };
  /** What was requested/recorded for MCP (names + globs, never values). */
  mcp?: {
    supported: boolean;
    agent: string | null;
    servers: string[];
    permissions: Record<string, 'allow' | 'deny'>;
  };
  /** True when the session was recreated after a worker restart. */
  resumed: boolean;
}

/**
 * Why a pump segment returned. A segment always ends quickly: it stops at the first
 * `permission.requested` instead of blocking the activity on a human decision (ADR-013).
 */
export type PumpStopReason = 'permission' | 'terminal' | 'cancelled' | 'closed';

export type PermissionDecisionValue = 'allow' | 'deny' | 'always';

export interface PumpResult {
  /** Status reported by the adapter's terminal event, if it emitted one. */
  terminalStatus: TerminalStatus | null;
  /** Summary carried by the adapter's terminal event. */
  terminalSummary?: string;
  /** Last `seq` persisted by this attempt. */
  lastSeq: number;
  /** Number of events appended in this attempt. */
  appended: number;
  /** Number of adapter payloads dropped (unmappable). */
  droppedEvents: number;
  /** Why the segment returned; `permission` means "wait for a human decision". */
  stopReason: PumpStopReason;
  /** Set when `stopReason === 'permission'`. */
  permissionRequestId?: string;
  /** Action the harness asked permission for (e.g. `bash`). */
  permissionAction?: string;
}

/** Payload of the permission decision Update/Signal (ADR-013). */
export interface PermissionDecisionInput {
  requestId: string;
  decision: PermissionDecisionValue;
}

export interface PermissionDecisionAck {
  accepted: boolean;
  requestId: string;
  decision: PermissionDecisionValue;
}

export interface RunArtifact {
  path: string;
  bytes: number;
  sha256: string;
  kind: 'patch' | 'log' | 'screenshot' | 'file';
}

export interface RunOutcome {
  runId: string;
  status: TerminalStatus;
  lastSeq: number;
  summary?: string;
}

export interface PersistEventInput {
  runId: string;
  /** Idempotency key; the same stepId never writes twice. */
  stepId: string;
  /** Event produced by an adapter (already has `seq`/`at`). */
  event?: unknown;
}

export interface AppendTerminalInput {
  runId: string;
  stepId: string;
  status: TerminalStatus;
  summary?: string;
}

export interface AppendTerminalResult {
  appended: boolean;
  seq: number | null;
}

export interface StepRecord {
  runId: string;
  stepId: string;
  kind: string;
  status: 'running' | 'ok' | 'error' | 'cancelled';
  detail?: unknown;
  error?: string;
}

/* ==================================================================== */
/* Factory loop (Phase 3a)                                              */
/*                                                                      */
/* Workflow-safe types only: no Node APIs, no Temporal worker imports.  */
/* ==================================================================== */

export type LoopStageName =
  | 'triage'
  | 'spec'
  | 'plan'
  | 'implement'
  | 'review'
  | 'verify'
  | 'ship';

/** Gate decision values accepted by `submitGateDecision`. */
export type GateDecisionValue = 'approve' | 'reject' | 'request_changes';

export type MergePolicyName =
  | 'human'
  | 'auto_on_green'
  | 'auto_after_n_approvals'
  | 'disabled';

/** Resolved per-stage configuration, flattened for the workflow sandbox. */
export interface StageNodeSummary {
  name: string;
  needs: string[];
  agent: string | null;
  reviewers: number;
  gate: string;
  gateSource: string;
  gateStage: string;
  harness: HarnessId | null;
  model: string | null;
  runner: RunnerKindName;
  tools: { allow: string[]; deny: string[] } | null;
}

export interface StageGraphSummary {
  /** Topological order. */
  order: string[];
  /** Parallel reviewer children per stage. */
  fanOut: Record<string, number>;
  nodes: StageNodeSummary[];
}

export interface AutonomySnapshot {
  enabled: boolean;
  paused: boolean;
  /** True when autonomy may auto-decide a gate (benchmark gate satisfied or overridden). */
  benchmarkGateSatisfied: boolean;
  actor?: string | null;
  reason?: string | null;
}

/** Carried across `continueAsNew` so a long loop keeps bounded history. */
export interface FactoryWorkflowResume {
  stageIndex: number;
  loopCount: number;
  stagesCompleted: number;
  attempts: Record<string, number>;
  currentStage: string;
  prUrl?: string;
  prNumber?: number;
  reviewVerdict?: ReviewVerdict;
  /** Implement run whose patch downstream stages run on (carried across continueAsNew). */
  patchRunId?: string;
}

export interface FactoryWorkflowInput {
  workItemId: string;
  factory: string;
  factoryRoot: string;
  definitionCommit: string;
  definitionDirty: boolean;
  title: string;
  /** Seed prompt for every stage run (work item title + source context). */
  prompt: string;
  sourceRef: Record<string, unknown>;
  repo?: { path?: string };
  stageGraph: StageGraphSummary;
  /** Resolved gate per loop stage (after the kill switch was applied). */
  gates: Record<string, string>;
  /** `advisory` approves a missing agent verdict; `required` requests changes. */
  agentVerdict?: AgentVerdictPolicy;
  mergePolicy: MergePolicyName;
  autonomy: AutonomySnapshot;
  loopLimit: number;
  gateSlaMs: number;
  /** `continueAsNew` after this many completed stages. */
  maxStagesPerRun: number;
  defaultHarness: HarnessId;
  /**
   * Explicit harness override for every stage (e.g. `harness: "fake"` on the API body).
   * Wins over the harness declared by the stage agent.
   */
  harnessOverride?: HarnessId;
  defaultModel?: string;
  defaultRunner: RunnerKindName;
  autoAllowPermissions: boolean;
  permissionTimeoutMs?: number;
  /**
   * ADR-022: when true the `ship` stage enqueues the pull request instead of merging it —
   * the merge queue owns merges. Absent/false keeps the Phase-3a behaviour (the loop merges
   * on a green gate).
   */
  mergeQueue?: boolean;
  /**
   * Item attempt (1-based). Attempt 1 runs as `factory-<id>`; a retry starts a fresh
   * workflow `factory-<id>-a<n>` because a closed Temporal workflow id cannot be reused.
   */
  attempt?: number;
  resume?: FactoryWorkflowResume;
}

export type FactoryOutcomeStatus = 'done' | 'escalated' | 'cancelled' | 'blocked';

export interface FactoryWorkflowOutcome {
  workItemId: string;
  status: FactoryOutcomeStatus;
  stage: string;
  stagesCompleted: number;
  loopCount: number;
  prUrl?: string;
  merged?: boolean;
  /** True when the pull request was handed to the merge queue instead of merged here. */
  queued?: boolean;
  reviewVerdict?: ReviewVerdict;
  reason?: string;
}

/** Payload of the `submitGateDecision` Update / `gateDecision` Signal. */
export interface GateDecisionInput {
  stage: LoopStageName;
  decision: GateDecisionValue;
  actor: string;
  reason?: string;
  feedback?: string;
  /** Attempt of the stage gate; the child accepts a decision only for its own attempt. */
  attempt?: number;
}

export interface GateDecisionAck {
  accepted: boolean;
  stage: LoopStageName;
  decision: GateDecisionValue;
}

/** Payload of the `autonomyPaused` kill-switch signal. */
export interface AutonomyPausedSignal {
  actor: string;
  reason: string;
}

/** Payload of the `cancelWorkItem` signal (harden-runtime, task 1.3). */
export interface CancelWorkItemSignal {
  actor: string;
  reason: string;
}

export type StagePhase = 'run' | 'review' | 'gate';

export interface StageWorkflowInput {
  workItemId: string;
  factory: string;
  factoryRoot: string;
  definitionCommit: string;
  definitionDirty: boolean;
  stage: LoopStageName;
  attempt: number;
  phase: StagePhase;
  reviewerIndex?: number;
  agent: string | null;
  harness: HarnessId;
  model?: string;
  runner: RunnerKindName;
  tools?: { allow: string[]; deny: string[] } | null;
  /** `human`, `agent`, `policy:<name>` or `none` (run-only children). */
  gate: string;
  /** What a missing agent verdict means for this factory (change `add-agent-verdicts`). */
  agentVerdict?: AgentVerdictPolicy;
  gateSlaMs: number;
  /** SLA fallback may auto-approve (autonomy policy + benchmark gate allow it). */
  autoApproveAllowed: boolean;
  title: string;
  prompt: string;
  repo?: { path?: string };
  /** Upstream run whose patch is applied to this stage's workspace (review/verify). */
  patchRunId?: string;
  permissionTimeoutMs?: number;
  /** Evidence attached to a gate-only child (review verdict / findings). */
  verdict?: ReviewVerdict;
  findings?: ReviewFinding[];
}

export interface StageGateOutcome {
  decision: GateDecisionValue;
  actor: string;
  automatic: boolean;
  reason?: string;
  feedback?: string;
  /** Verdict that produced an automatic agent-gate decision. */
  verdict?: AgentVerdict;
}

export interface StageWorkflowResult {
  stage: LoopStageName;
  runId: string | null;
  status: 'ok' | 'failed' | 'cancelled';
  gate: StageGateOutcome | null;
  report?: ReviewerReport;
  summary?: string;
}

/* ------------------------------------------------------------- judgement */

export const JUDGEMENT_CLASSIFICATIONS = ['implement', 'spec', 'wait', 'reject'] as const;
export type JudgementClassification = (typeof JUDGEMENT_CLASSIFICATIONS)[number];

export interface JudgementResult {
  classification: JudgementClassification;
  confidence: number;
  reason: string;
  /** How many model attempts were needed (invalid output is retried). */
  attempts: number;
  model: string;
}

/* ---------------------------------------------------------------- review */

export type ReviewFindingSeverity = 'info' | 'warning' | 'blocker';

export interface ReviewFinding {
  reviewer: string;
  severity: ReviewFindingSeverity;
  summary: string;
  file?: string;
}

export interface ReviewerReport {
  reviewer: string;
  reviewerIndex: number;
  runId: string | null;
  verdict: 'approve' | 'reject';
  findings: ReviewFinding[];
  confidence: number;
}

export type ReviewVerdictValue = 'approve' | 'needs_human' | 'reject';

export interface ReviewVerdict {
  verdict: ReviewVerdictValue;
  findings: ReviewFinding[];
  confidence: number;
  reviewers: number;
  /** Always true: the committee never approves or merges; it only advises. */
  advisory: true;
  /** Set when fewer reports than configured reviewers arrived. */
  incomplete?: boolean;
}

/* ------------------------------------------------------- workflow ids */

/**
 * One workflow per work item attempt (design decision 1: id is derived from the item).
 * The first attempt keeps the historical id; a retry must use a new id because a closed
 * Temporal workflow cannot be started again under the same id.
 */
export function workItemWorkflowId(workItemId: string, attempt = 1): string {
  return attempt <= 1 ? `factory-${workItemId}` : `factory-${workItemId}-a${attempt}`;
}

/** One child workflow per stage attempt / reviewer / gate. */
export function stageWorkflowId(
  workItemId: string,
  stage: string,
  attempt: number,
  suffix?: string,
): string {
  return `stage-${workItemId}-${stage}-${attempt}${suffix ? `-${suffix}` : ''}`;
}

/** One child workflow per run. */
export function runWorkflowIdFor(runId: string): string {
  return `run-${runId}`;
}

/** Run id for a stage (reviewers get their own independent run). */
export function stageRunId(
  workItemId: string,
  stage: string,
  attempt: number,
  reviewerIndex?: number,
): string {
  return `run_${workItemId.slice(3)}_${stage}_${attempt}${reviewerIndex ? `_r${reviewerIndex}` : ''}`;
}

/* ==================================================================== */
/* Scoring (Phase 4a)                                                   */
/*                                                                      */
/* Workflow-safe types only: no Node APIs, no Temporal worker imports.  */
/* ==================================================================== */

export type ScoringTrigger = 'scheduled' | 'on_demand';
export type ScoringJudgeMode = 'stub' | 'openai';

export interface ScoringWorkflowInput {
  /** Factory name as declared in `factory.yaml`. */
  factory: string;
  /** Absolute path of the factory definition directory on the worker host. */
  factoryRoot: string;
  trigger: ScoringTrigger;
  /** On-demand: score exactly these runs (bypasses sampling, not the budget). */
  runIds?: string[];
  workItemId?: string;
  stage?: string;
  /** Scheduled window: terminal runs started within the last N days. */
  windowDays?: number;
  /** Explicit human request: bypass the sampling draw and cadence. */
  force?: boolean;
  maxScoresPerDay?: number;
  cadenceMs?: number;
  judgeMode?: ScoringJudgeMode;
}

export interface ScorableRunSummary {
  runId: string;
  workItemId: string | null;
  stage: string | null;
  status: string;
}

export type ScoringSkipReason = 'sampled_out' | 'budget_exhausted' | 'cadence';

export interface ScoringPlanItem {
  runId: string;
  workItemId: string | null;
  stage: string | null;
  scorer: string;
  scorerClass: 'deterministic' | 'judge';
  rubricHash: string;
  selected: boolean;
  reason: ScoringSkipReason | null;
}

export interface ScoringPlan {
  items: ScoringPlanItem[];
  /** At least one judge item was skipped because the daily cap was reached. */
  budgetExhausted: boolean;
}

export interface ScoringWorkflowOutcome {
  factory: string;
  scoreRunId: string;
  runs: number;
  scorers: number;
  scored: number;
  errored: number;
  skipped: number;
  budgetExhausted: boolean;
  error?: string;
}

/* ==================================================================== */
/* Benchmarks (Phase 4b)                                                */
/*                                                                      */
/* Workflow-safe types only: no Node APIs, no Temporal worker imports.  */
/* ==================================================================== */

export type BenchmarkStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled';
export type BenchmarkTrialStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped';

/** One (task × configuration) trial, resolved by the API before the workflow starts. */
export interface BenchmarkTrialPlan {
  trialId: string;
  configuration: string;
  task: string;
  runId: string;
  prompt: string;
  successCriteria: string;
  /** Full 40-char SHAs; a trial is pinned to them. */
  startingRepoRefs: string[];
  tags: string[];
  /** Fresh fake-forge repo key for this trial. */
  repo: string;
  /** Tags may declare `requires-network`; a hermetic trial then fails `network_denied`. */
  requiresNetwork: boolean;
  /**
   * Recorded run this trial replays (spec `benchmark-replay`). Set, the trial runs the
   * replay adapter and is scored without a model call; a missing recording fails
   * `replay_missing`.
   */
  replayFrom?: string | null;
}

export interface BenchmarkWorkflowInput {
  benchmarkRunId: string;
  factory: string;
  factoryRoot: string;
  /** Git root that contains `factoryRoot`; pinned repo path for the hermetic trial. */
  repoRoot?: string;
  suite: string;
  definitionCommit: string;
  definitionDirty: boolean;
  /** sha256 over the full normalized matrix + definitionCommit. */
  configHash: string;
  trials: BenchmarkTrialPlan[];
  harness: HarnessId;
  model?: string;
  runner: RunnerKindName;
  /** Max concurrent child runs; the workflow fans out in deterministic batches. */
  concurrency: number;
  estimateUsd: number;
  maxCostUsd: number;
  passThreshold: number;
  /** True only when every declared task × configuration is in `trials`. */
  fullMatrix: boolean;
  judgeMode?: ScoringJudgeMode;
  permissionTimeoutMs?: number;
}

export interface BenchmarkTrialOutcome {
  trialId: string;
  configuration: string;
  task: string;
  runId: string | null;
  status: BenchmarkTrialStatus;
  errorCode: string | null;
  score: number | null;
  passing: boolean;
  costUsd: number;
  uncalibrated: boolean;
}

export interface BenchmarkWorkflowOutcome {
  benchmarkRunId: string;
  status: BenchmarkStatus;
  passRate: number | null;
  calibrationOk: boolean;
  passed: boolean;
  sampleSize: number;
  costUsd: number;
  errors: number;
  skipped: number;
  budgetExhausted: boolean;
  attestationId?: string;
  trials: BenchmarkTrialOutcome[];
  error?: string;
}

/** One benchmark workflow per run; id derived from the run id (stable across retries). */
export function benchmarkWorkflowId(benchmarkRunId: string): string {
  return `benchmark-${benchmarkRunId}`;
}

/** One child run per (task × configuration) trial. */
export function benchmarkTrialRunId(
  benchmarkRunId: string,
  configurationIndex: number,
  taskIndex: number,
): string {
  return `run_bench_${benchmarkRunId.replace(/^bench_/, '')}_${configurationIndex}_${taskIndex}`;
}

/* ==================================================================== */
/* Self-improvement (Phase 5)                                          */
/*                                                                      */
/* Workflow-safe types only: no Node APIs, no Temporal worker imports.  */
/* ==================================================================== */

export type ImprovementTriggerName = 'scheduled' | 'on_demand';
export type ImprovementAuthorityName = 'propose_only' | 'auto_merge_on_benchmark' | 'canary';

export interface ImprovementWorkflowInput {
  improvementRunId: string;
  factory: string;
  factoryRoot: string;
  definitionCommit: string;
  definitionDirty: boolean;
  trigger: ImprovementTriggerName;
  /** Resolved from the definition (`improvement.authority`), never guessed. */
  authority: ImprovementAuthorityName;
  canaryPercent: number | null;
  rollbackThreshold: number | null;
  observationWindowHours: number;
  maxProbes: number;
  /** Minimum distinct scored runs before the observer may propose. */
  minScoredRuns: number;
  /** Scored-corpus window in days. */
  windowDays: number;
  /** Cap on proposals kept after dedupe (ranked by impact). */
  maxProposals: number;
  judgeMode?: ScoringJudgeMode;
  /** On-demand filter: observe exactly these runs. */
  runIds?: string[];
  /** Definition repo (`owner/name`) that receives the proposal PR. */
  definitionRepo: string;
  baseBranch?: string;
}

export interface ImprovementProposalOutcome {
  proposalId: string;
  title: string;
  failureSignature: string;
  impact: number;
  status: string;
  candidateHash: string | null;
  prUrl: string | null;
  prNumber: number | null;
  /** Per-edit probe results (winner + delta). */
  probes: { editPath: string; kind: string; delta: number | null; winner: boolean }[];
  /** Edits rejected by the blast-radius guard or by a losing probe. */
  rejected: { path: string; code: string }[];
}

export interface ImprovementWorkflowOutcome {
  improvementRunId: string;
  status: 'completed' | 'error' | 'skipped';
  /** Terminal decision summary (`ineligible`, `no_improvement`, `pr_opened`, `merged`, ...). */
  decision: string;
  proposals: ImprovementProposalOutcome[];
  lessons: string[];
  eligibility: Record<string, unknown>;
  error?: string;
}

/** One improvement workflow per run; id derived from the run id (stable across retries). */
export function improvementWorkflowId(improvementRunId: string): string {
  return `improvement-${improvementRunId}`;
}

/* ==================================================================== */
/* Canary rollout (Phase 5b)                                            */
/*                                                                      */
/* Workflow-safe types only: no Node APIs, no Temporal worker imports.  */
/* ==================================================================== */

/** Why a canary rollout ended. */
export type CanaryOutcomeStatus = 'promoted' | 'rolled_back' | 'unavailable';

export interface CanaryWorkflowInput {
  rolloutId: string;
  factory: string;
  /** Stable definition tree on the worker host (read-only mount). */
  factoryRoot: string;
  proposalId: string;
  /** Definition repo (`owner/name`) that receives the candidate branch + PR. */
  definitionRepo: string;
  baseBranch?: string;
  stableVersion: string;
  stableCommit: string;
  candidateVersion: string;
  canaryPercent: number;
  rollbackThreshold: number;
  observationWindowHours: number;
  /**
   * Test/short-window override. The window normally comes from
   * `improvement.observationWindowHours`; an integration test needs seconds, not hours.
   */
  observationWindowMs?: number;
  /** How often the workflow re-reads the metrics while the window is open. */
  checkIntervalMs?: number;
  /** Who started the rollout (recorded on every event). */
  actor: string;
  reason?: string;
}

/** Snapshot returned by `observeCanaryActivity`. */
export interface CanaryObservationSummary {
  rolloutId: string;
  status: string;
  reason: string | null;
  /** Actor that finalised the rollout (manual rollback/promotion), when recorded. */
  actor?: string | null;
  startedAt: string | null;
  endedAt: string | null;
  canaryPercent: number;
  rollbackThreshold: number;
  observationWindowHours: number;
  stable: CanaryStatsSummary;
  candidate: CanaryStatsSummary;
  threshold: number;
  passRateDelta: number | null;
  failureRateDelta: number | null;
  regressionExceeded: boolean;
  regressionReason: string | null;
  detail: string;
  insufficientData: boolean;
  evidence: Record<string, unknown>;
}

export interface CanaryStatsSummary {
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

/**
 * One hourly bucket of the rollout time series (harden-runtime, task 5.2). Derived from
 * `scores` + `runs`; an empty bucket is `null` with a reason, never zero.
 */
export interface CanarySeriesBucket {
  bucketStart: string;
  bucketEnd: string;
  version: 'stable' | 'candidate';
  scores: number;
  passing: number;
  passRate: number | null;
  runs: number;
  failedRuns: number;
  errorRate: number | null;
  /** `no_runs_in_bucket` when the bucket is empty; otherwise null. */
  reason: string | null;
}

export interface CanarySeriesSummary {
  rolloutId: string;
  bucketHours: number;
  from: string;
  to: string;
  stable: CanarySeriesBucket[];
  candidate: CanarySeriesBucket[];
}

export interface CanaryWorkflowOutcome {
  rolloutId: string;
  status: CanaryOutcomeStatus;
  /** `promoted`, `manual_rollback`, `pass_rate_regression`, `incident_rate_regression`, ... */
  reason: string;
  actor: string;
  observation: CanaryObservationSummary | null;
  candidateVersion: string;
  stableVersion: string;
  promotedCommit?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
}

/** Payload of the manual `canaryRollback` / `canaryPromote` signals. */
export interface CanaryDecisionSignal {
  actor: string;
  reason: string;
}

/** One canary workflow per rollout; id derived from the rollout id. */
export function canaryWorkflowId(rolloutId: string): string {
  return `canary-${rolloutId}`;
}

/* ==================================================================== */
/* Merge queue (Phase 3b)                                               */
/*                                                                      */
/* Workflow-safe types only: no Node APIs, no Temporal worker imports.  */
/* ==================================================================== */

export interface MergeQueueWorkflowInput {
  factory: string;
  /** `owner/name` of the repository the queue merges into. */
  repo: string;
  /** Pull requests merged per batch (spec: configurable, default 2). */
  batchSize: number;
  /** How long the merged stack may stay pending before `checks_timeout`. */
  checksTimeoutMs: number;
  pollIntervalMs: number;
  /** Stop after this many batches (a long-lived queue is re-started by the next enqueue). */
  maxBatches: number;
  /** When the queue is empty, wait this long for new work before completing. */
  idleIntervalMs?: number;
  /** How many empty waits are allowed before the workflow completes. */
  maxIdleCycles?: number;
  /** Who owns the queue run (recorded on events). */
  actor?: string;
}

export interface MergeQueueBatchOutcome {
  batchId: string;
  status: string;
  merged: number[];
  needsHuman: number[];
  reverted: boolean;
  reason?: string;
}

export interface MergeQueueWorkflowOutcome {
  factory: string;
  batches: MergeQueueBatchOutcome[];
  completed: boolean;
  error?: string;
}

/** One merge queue per factory; the id is derived from the factory name. */
export function mergeQueueWorkflowId(factory: string): string {
  return `merge-queue-${factory}`;
}

/* ==================================================================== */
/* Scheduled automations (Phase 3b)                                     */
/*                                                                      */
/* Workflow-safe types only: no Node APIs, no Temporal worker imports.  */
/* ==================================================================== */

export interface AutomationWorkflowInput {
  factory: string;
  factoryRoot: string;
  /** Automation resource name (`automations/<name>/automation.md`). */
  automation: string;
  /** `automation_schedules.id` — `<factory>:<automation>`. */
  scheduleId: string;
  cron: string;
  /** Idempotency key: the fire timestamp (schedule id + timestamp). */
  fireAt?: string;
  title?: string;
  prompt?: string;
  harness?: HarnessId;
  model?: string;
  runner?: RunnerKindName;
}

export interface AutomationWorkflowOutcome {
  factory: string;
  automation: string;
  fireAt: string;
  workItemId: string | null;
  created: boolean;
  skipped: boolean;
  reason?: string;
}

/** One workflow per schedule fire; the id includes the fire timestamp. */
export function automationWorkflowId(scheduleId: string, fireAt: string): string {
  return `automation-${scheduleId}-${fireAt.replace(/[^0-9]/g, '')}`;
}

export interface MergeRevertWorkflowInput {
  factory: string;
  batchId: string;
  actor: string;
  reason: string;
}

export interface MergeRevertWorkflowOutcome {
  factory: string;
  batchId: string;
  status: string;
  sha: string | null;
  prs: number[];
  error?: string;
}

/** One workflow per revert; the id includes a timestamp so repeated reverts are distinct. */
export function mergeRevertWorkflowId(batchId: string, at: string): string {
  return `merge-revert-${batchId}-${at.replace(/[^0-9]/g, '')}`;
}

/* ==================================================================== */
/* MCP connection test (change add-secrets-and-mcp)                     */
/*                                                                      */
/* Workflow-safe types only: no Node APIs, no Temporal worker imports.  */
/* ==================================================================== */

export interface McpTestWorkflowInput {
  factory: string;
  factoryRoot: string;
  /** Declared server name (`mcp.servers[].name`). */
  server: string;
  /** Probe timeout in ms; defaults to 5s. */
  timeoutMs?: number;
}

export interface McpTestWorkflowOutcome {
  factory: string;
  server: string;
  transport: string;
  ok: boolean;
  latencyMs: number;
  error: string | null;
  /** Where the probe executed (always the runner/worker host, never the API — ADR-010). */
  executor: string;
}

/** One workflow per probe; the id includes a timestamp so repeated tests are distinct. */
export function mcpTestWorkflowId(factory: string, server: string, at: string): string {
  return `mcp-test-${factory}-${server}-${at.replace(/[^0-9]/g, '')}`;
}
