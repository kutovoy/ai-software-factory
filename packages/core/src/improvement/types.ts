/**
 * Persistence shapes for the self-improvement loop (Phase 5, ADR-020).
 *
 * The DB is a read model: proposals, probes and lessons are derived records. The
 * definition (including `improvement.authority`) stays in git; an authority change is a
 * definition change, not a DB toggle.
 */

export type ImprovementTrigger = 'scheduled' | 'on_demand';
export type ImprovementRunStatus = 'queued' | 'running' | 'completed' | 'error' | 'skipped';

export type ProposalKind = 'improvement' | 'authority_change';
export type ProposalStatus =
  | 'open'
  | 'accepted'
  | 'rejected'
  | 'no_improvement'
  | 'pr_open'
  | 'merged'
  | 'canary'
  | 'rolled_back'
  /** Historical status from Phase 5a; no longer produced but kept readable. */
  | 'canary_not_available'
  | 'failed';

export type ProposalEditKind = 'invariant' | 'domain';
export type ProposalEditScope = 'in_scope' | 'out_of_scope';

export interface ImprovementRunRecord {
  id: string;
  factory: string;
  definitionCommit: string;
  trigger: ImprovementTrigger;
  status: ImprovementRunStatus;
  authority: string;
  eligibility: Record<string, unknown>;
  proposals: number;
  lessons: number;
  /** Terminal decision summary (`pr_opened`, `merged`, `no_improvement`, `ineligible`, ...). */
  decision: string | null;
  error: string | null;
  workflowId: string | null;
  temporalRunId: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ProposalRecord {
  id: string;
  improvementRunId: string | null;
  factory: string;
  kind: ProposalKind;
  authority: string;
  status: ProposalStatus;
  title: string;
  summary: string;
  /** failed runs × quality/cost delta; used for ranking. */
  impact: number;
  evidence: Record<string, unknown>;
  failureSignature: string;
  /** Files the proposal touches (POSIX paths relative to the definition root). */
  files: string[];
  /** `[{path, before, after}]` — a textual diff of the candidate definition. */
  diff: { path: string; before: string; after: string }[];
  candidateHash: string | null;
  prUrl: string | null;
  prNumber: number | null;
  decisionActor: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ProposalEditRecord {
  id: string;
  proposalId: string;
  kind: ProposalEditKind;
  path: string;
  rationale: string;
  /** Replacement body for the file (Markdown body or YAML document). */
  content: string;
  scope: ProposalEditScope;
  rejected: boolean;
  /** `edit_out_of_scope` for scope rejections, `no_signal` for losing probes. */
  rejectionCode: string | null;
  contrast: Record<string, unknown> | null;
  createdAt: string | null;
}

export interface ProbeRecord {
  id: string;
  proposalId: string;
  editId: string;
  workItemId: string | null;
  runId: string | null;
  /** Matched inputs: the baseline and candidate ran the same item + scorer. */
  matchedInputs: Record<string, unknown>;
  baselineScore: number | null;
  candidateScore: number | null;
  delta: number | null;
  /** True when the candidate improved the contrastive signal. */
  winner: boolean;
  createdAt: string | null;
}

export interface LessonRecord {
  id: string;
  factory: string;
  cue: string;
  lesson: string;
  evidence: Record<string, unknown>;
  confidence: number;
  proposalId: string | null;
  /** Origin factory when the lesson is promoted into the shared library. */
  originFactory: string;
  promoted: boolean;
  promotedBy: string | null;
  promotedAt: string | null;
  createdAt: string | null;
}

export interface ImprovementEventRecord {
  id: number;
  improvementRunId: string;
  factory: string;
  type: string;
  /** Proposal id (or '' for run-level events); part of the dedupe key. */
  subject: string;
  payload: Record<string, unknown>;
  createdAt: string | null;
}

/**
 * Canary rollout state (Phase 5b, ADR-021). A rollout is created `pending`, becomes
 * `active` once the candidate version is published, and ends `promoted` or `rolled_back`.
 */
export type CanaryStatus = 'pending' | 'active' | 'promoted' | 'rolled_back' | 'unavailable';

export interface CanaryRolloutRecord {
  id: string;
  factory: string;
  proposalId: string;
  /** `factory-vN+1-candidate` (or `candidate-<sha8>` when the repo has no version tag). */
  candidateVersion: string;
  stableVersion: string;
  /** Commit of the published candidate (fake-forge content hash in CI). */
  candidateCommit: string | null;
  stableCommit: string | null;
  /** Materialised candidate definition tree the candidate work items run from. */
  candidateRoot: string | null;
  canaryPercent: number;
  rollbackThreshold: number;
  observationWindowHours: number;
  status: CanaryStatus;
  reason: string | null;
  prUrl: string | null;
  prNumber: number | null;
  actor: string | null;
  evidence: Record<string, unknown>;
  startedAt: string | null;
  endedAt: string | null;
}

export interface CanaryEventRecord {
  id: number;
  rolloutId: string;
  factory: string;
  type: string;
  /** Rollout id or the manual/automatic subject; part of the dedupe key. */
  subject: string;
  payload: Record<string, unknown>;
  createdAt: string | null;
}

export interface ProposalFilters {
  factory?: string;
  status?: ProposalStatus;
  kind?: ProposalKind;
  improvementRunId?: string;
  limit?: number;
  offset?: number;
}

export interface LessonFilters {
  factory?: string;
  /** Include lessons other factories promoted into the shared library. */
  includeShared?: boolean;
  promoted?: boolean;
  limit?: number;
}
