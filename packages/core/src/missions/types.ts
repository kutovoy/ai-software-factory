import type { ValidationTier } from '../validation/types';
import type { GateDecisionValue, WorkItemType } from '../work-items/types';

/**
 * Mission domain types (roadmap item 12).
 *
 * A mission is a durable goal above work items. It owns a plan, milestones, features,
 * checkpoints, events, gates and validations. Work items remain the execution unit: every
 * feature is a work item that runs the existing factory stage graph.
 */

export const MISSION_STATUSES = [
  'planning',
  'awaiting_plan_approval',
  'running',
  'paused',
  'blocked',
  'done',
  'failed',
  'cancelled',
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const MISSION_FEATURE_STATUSES = [
  'pending',
  'ready',
  'running',
  'done',
  'failed',
  'skipped',
] as const;
export type MissionFeatureStatus = (typeof MISSION_FEATURE_STATUSES)[number];

export const MISSION_MILESTONE_STATUSES = [
  'pending',
  'running',
  'validating',
  'done',
  'failed',
  'blocked',
] as const;
export type MissionMilestoneStatus = (typeof MISSION_MILESTONE_STATUSES)[number];

export const MISSION_VALIDATION_KINDS = ['scrutiny', 'user-testing', 'contract'] as const;
export type MissionValidationKind = (typeof MISSION_VALIDATION_KINDS)[number];

export const MISSION_VALIDATION_STATUSES = ['pending', 'running', 'passed', 'failed', 'error'] as const;
export type MissionValidationStatus = (typeof MISSION_VALIDATION_STATUSES)[number];

export const MISSION_EVENT_TYPES = [
  'mission.created',
  'mission.planning.started',
  'mission.plan.proposed',
  'mission.plan.approved',
  'mission.plan.rejected',
  'mission.plan.changes_requested',
  'mission.started',
  'mission.milestone.started',
  'mission.feature.started',
  'mission.feature.completed',
  'mission.feature.failed',
  'mission.feature.retried',
  'mission.validation.started',
  'mission.validation.passed',
  'mission.validation.failed',
  'mission.fix_feature.created',
  'mission.checkpoint',
  'mission.paused',
  'mission.resumed',
  'mission.replanned',
  'mission.cancelled',
  'mission.blocked',
  'mission.budget_exhausted',
  'mission.done',
] as const;
export type MissionEventType = (typeof MISSION_EVENT_TYPES)[number];

/** `mis_` + a 26-character Crockford base32 ULID. */
export const MISSION_ID_RE = /^mis_[0-9A-HJKMNP-TV-Z]{26}$/;
export const MISSION_MILESTONE_ID_RE = /^mst_[0-9A-HJKMNP-TV-Z]{26}$/;
export const MISSION_FEATURE_ID_RE = /^mft_[0-9A-HJKMNP-TV-Z]{26}$/;
export const MISSION_VALIDATION_ID_RE = /^mval_[0-9A-HJKMNP-TV-Z]{26}$/;

export interface MissionBudget {
  /** Hard spend cap for the whole mission (USD). */
  maxCostUsd?: number;
  /** Maximum feature + validation runs the mission may start. */
  maxRuns?: number;
  /** Maximum wall-clock time in hours before the mission blocks. */
  maxWallClockHours?: number;
}

/** One behavioral assertion in the mission-level validation contract. */
export interface MissionValidationAssertion {
  id: string;
  title: string;
  /** The observable behavior the validator must exercise or inspect. */
  assertion: string;
  tier: ValidationTier;
  required: boolean;
  /** Tool the validator should use, e.g. `agent-browser`, `playwright`, `command`, `manual`. */
  tool: string;
  /** Expected evidence, e.g. `screenshot`, `network`, `exit code 0`, `artifact`. */
  evidence: string;
  command?: string;
  expected?: string;
}

export interface MissionValidationContract {
  version: 'v1alpha1';
  missionId: string;
  factory: string;
  definitionCommit: string;
  createdAt: string;
  enforce: boolean;
  assertions: MissionValidationAssertion[];
  risks: string[];
  source: 'orchestrator' | 'human' | 'factory';
}

export interface MissionFeaturePlan {
  id: string;
  title: string;
  description: string;
  order: number;
  /** Feature ids that must be done before this feature can start. */
  dependsOn: string[];
  /** Validation assertion ids this feature claims to fulfill. */
  acceptanceCheckIds: string[];
  /** Defaults to `task`. */
  workItemType?: WorkItemType;
}

export interface MissionMilestonePlan {
  id: string;
  title: string;
  description: string;
  order: number;
  features: MissionFeaturePlan[];
}

export interface MissionPlan {
  version: 'v1alpha1';
  missionId: string;
  factory: string;
  definitionCommit: string;
  title: string;
  goal: string;
  createdAt: string;
  validationContract: MissionValidationContract;
  milestones: MissionMilestonePlan[];
  risks: string[];
  assumptions: string[];
}

export interface Mission {
  id: string;
  factory: string;
  factoryId: string | null;
  title: string;
  goal: string;
  status: MissionStatus;
  definitionCommit: string;
  definitionDirty: boolean;
  factoryRoot: string;
  definitionVersion: 'stable' | 'candidate';
  canaryRolloutId: string | null;
  plan: MissionPlan | null;
  planVersion: number;
  currentMilestoneId: string | null;
  currentFeatureId: string | null;
  workflowId: string | null;
  attempt: number;
  budget: MissionBudget;
  error: string | null;
  cancelRequestedAt: string | null;
  cancelActor: string | null;
  cancelReason: string | null;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface MissionMilestone {
  id: string;
  missionId: string;
  ordinal: number;
  title: string;
  description: string;
  status: MissionMilestoneStatus;
  validationRound: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface MissionFeature {
  id: string;
  missionId: string;
  milestoneId: string;
  ordinal: number;
  title: string;
  description: string;
  status: MissionFeatureStatus;
  dependsOn: string[];
  acceptanceCheckIds: string[];
  workItemId: string | null;
  fixForFeatureId: string | null;
  attempt: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface MissionCheckpoint {
  id: number;
  missionId: string;
  seq: number;
  kind: string;
  milestoneId: string | null;
  featureId: string | null;
  dedupeKey: string | null;
  state: Record<string, unknown>;
  createdAt: string | null;
}

export interface MissionEvent {
  id: number;
  missionId: string;
  type: string;
  milestoneId: string | null;
  featureId: string | null;
  actor: string | null;
  payload: Record<string, unknown>;
  createdAt: string | null;
}

export interface MissionGate {
  missionId: string;
  gate: string;
  attempt: number;
  workflowId: string | null;
  decision: GateDecisionValue | null;
  actor: string | null;
  reason: string | null;
  feedback: string | null;
  requestedAt: string | null;
  slaAt: string | null;
  decidedAt: string | null;
}

export interface MissionValidation {
  id: string;
  missionId: string;
  milestoneId: string;
  round: number;
  kind: MissionValidationKind;
  runId: string | null;
  status: MissionValidationStatus;
  verdict: 'approve' | 'reject' | 'needs_human' | null;
  findings: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface MissionProgress {
  features: { total: number; done: number; failed: number; running: number };
  milestones: { total: number; done: number; running: number };
  currentMilestoneId: string | null;
  currentFeatureId: string | null;
}
