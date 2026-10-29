/**
 * Workflow-safe types. Nothing in this file may import Node APIs or Temporal worker
 * packages: it is bundled into the deterministic workflow sandbox.
 */

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
  /** First human message. Chat and factory runs share this field (ADR-002). */
  prompt: RunPrompt | null;
  kind: 'chat' | 'run';
  title?: string;
  /** Models this run may call through the inference proxy. Empty/absent → no proxy. */
  proxyModels: string[];
  /** Scripted adapter step delay; lets tests kill the worker mid-run. */
  fakeDelayMs?: number;
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
}

export interface LeaseInfo {
  runnerId: string;
  kind: 'docker' | 'local';
  workspace: string;
  harnessUrl?: string;
  /** True when the run uses the in-process scripted adapter (no sandbox process). */
  ephemeral: boolean;
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
  gateSlaMs: number;
  /** SLA fallback may auto-approve (autonomy policy + benchmark gate allow it). */
  autoApproveAllowed: boolean;
  title: string;
  prompt: string;
  repo?: { path?: string };
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

/** One workflow per work item (design decision 1: id is derived from the item). */
export function workItemWorkflowId(workItemId: string): string {
  return `factory-${workItemId}`;
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
