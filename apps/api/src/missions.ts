import { z } from 'zod';
import {
  MISSION_FEATURE_ID_RE,
  MISSION_ID_RE,
  MISSION_STATUSES,
  appendMissionEvent,
  createMission,
  decideMissionGate,
  getMission,
  getMissionFeature,
  getPendingMissionGate,
  listMissionCheckpoints,
  listMissionEvents,
  listMissionFeatures,
  listMissionGates,
  listMissionMilestones,
  listMissionValidations,
  listMissionWorkItems,
  listMissions,
  missionBudgetExceeded,
  missionBudgetSchema,
  missionBudgetUsage,
  missionControlBodySchema,
  missionPlanDecisionBodySchema,
  missionRetryFeatureBodySchema,
  missionStatusSchema,
  newMissionId,
  persistMissionPlan,
  requestMissionCancel,
  setMissionFeatureStatus,
  updateMissionStatus,
  validateMissionPlan,
  type Mission,
  type MissionBudget,
  type MissionBudgetUsageRecord,
  type MissionCheckpoint,
  type MissionEvent,
  type MissionFeature,
  type MissionGate,
  type MissionMilestone,
  type MissionPlan,
  type MissionSummary,
  type MissionValidation,
} from '@factory/core';
import {
  cancelMission,
  getSql,
  missionWorkflowId,
  pauseMission,
  resumeMission,
  startMissionWorkflow,
  submitMissionPlanDecision,
  type MissionBudgetData,
  type MissionDecisionDelivery,
  type MissionPlanDecisionInput,
  type MissionPlanData,
  type MissionWorkflowInput,
} from '@factory/orchestration';
import type { ApiConfig } from './config';
import { toOrchestrationConfig } from './config';
import { canAccess, ownerFilter, type Viewer } from './auth';
import {
  ApiError,
  invalidMissionPlan,
  invalidRequest,
  invalidState,
  missionFeatureNotFound,
  missionGateNotFound,
  missionNotFound,
} from './errors';
import type { FactoryRecord } from './factories';
import { resolveFactoryDir } from './factories';
import { log } from './logger';
import { pinVersion } from './runs';
import { summarize as summarizeWorkItem } from './work-items';

/**
 * Long-running mission routes (change `add-long-running-missions`, spec `http-api` ›
 * Mission API).
 *
 * The API is the durable read model and the control surface: it creates the mission row,
 * pins the definition commit, starts `MissionWorkflow`, records plan decisions and control
 * requests in Postgres first, then delivers them to the workflow by Update/Signal. The
 * workflow remains the execution authority; the API never dispatches work itself.
 */

/** `POST /missions` body. A supplied plan is validated with `validateMissionPlan`. */
export const createMissionBodySchema = z
  .object({
    title: z.string().min(1).max(200),
    goal: z.string().min(1).max(20_000),
    budget: missionBudgetSchema.optional(),
    /** Full plan; identity fields (`missionId`, `factory`, `definitionCommit`) are pinned by the API. */
    plan: z.unknown().optional(),
  })
  .strict();

export type CreateMissionBody = z.infer<typeof createMissionBodySchema>;

export type MissionPlanDecisionBody = z.infer<typeof missionPlanDecisionBodySchema>;

/** A mission summary carries the progress counts and spend the list projection promises. */
export interface MissionSummaryView extends Mission {
  featureTotal: number;
  featureDone: number;
  featureFailed: number;
  milestoneTotal: number;
  milestoneDone: number;
  spendUsd: number;
}

export interface CreatedMission {
  mission: MissionSummaryView;
  workflow: { workflowId: string; temporalRunId: string } | null;
}

export interface MissionBudgetUsageView {
  budget: MissionBudget;
  spendUsd: number;
  runs: number;
  startedAt: string | null;
  remainingUsd: number | null;
  remainingRuns: number | null;
  wallClockHours: number | null;
  costExhausted: boolean;
  runsExhausted: boolean;
  wallClockExhausted: boolean;
  exhausted: boolean;
}

export interface MissionDetail {
  mission: MissionSummaryView;
  milestones: MissionMilestone[];
  features: MissionFeature[];
  checkpoints: MissionCheckpoint[];
  events: MissionEvent[];
  validations: MissionValidation[];
  gates: MissionGate[];
  pendingGate: MissionGate | null;
  workItems: ReturnType<typeof summarizeWorkItem>[];
  budget: {
    budget: MissionBudget;
    usage: MissionBudgetUsageRecord;
    /** Stable reason when a cap is reached, else null (spec `missions` › Mission budget). */
    exceeded: string | null;
  };
  /** The flattened form the console renders; kept alongside `budget` for API consumers. */
  budgetUsage: MissionBudgetUsageView;
}

export interface ListMissionsFilters {
  status?: string;
  limit?: number;
  offset?: number;
}

const TERMINAL_MISSION_STATUSES = new Set(['done', 'failed', 'cancelled']);

function planIdentity(
  plan: unknown,
  identity: {
    missionId: string;
    factory: string;
    definitionCommit: string;
    title: string;
    goal: string;
  },
): MissionPlan {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw invalidRequest('`plan` must be a JSON object', { plan });
  }

  const input = plan as Record<string, unknown>;
  const contract = input.validationContract;
  const contractObject =
    contract && typeof contract === 'object' && !Array.isArray(contract)
      ? (contract as Record<string, unknown>)
      : null;

  // Identity fields are authoritative from the server: a client cannot know the mission id
  // before creation, and the pinned commit must match the row it is stored on.
  const createdAt =
    typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString();
  const candidate: Record<string, unknown> = {
    ...input,
    missionId: identity.missionId,
    factory: identity.factory,
    definitionCommit: identity.definitionCommit,
    title: typeof input.title === 'string' ? input.title : identity.title,
    goal: typeof input.goal === 'string' ? input.goal : identity.goal,
    createdAt,
    validationContract:
      contractObject && typeof contractObject === 'object'
        ? {
            ...contractObject,
            missionId: identity.missionId,
            factory: identity.factory,
            definitionCommit: identity.definitionCommit,
            createdAt:
              typeof contractObject.createdAt === 'string'
                ? contractObject.createdAt
                : createdAt,
          }
        : contract,
  };

  const validation = validateMissionPlan(candidate);
  if (!validation.plan) {
    throw invalidMissionPlan(identity.factory, validation.errors);
  }
  return validation.plan;
}

async function missionSummaryView(mission: Mission): Promise<MissionSummaryView> {
  const sql = getSql();
  const [features, milestones, usage] = await Promise.all([
    listMissionFeatures(sql, mission.id),
    listMissionMilestones(sql, mission.id),
    missionBudgetUsage(sql, mission.id),
  ]);

  return {
    ...mission,
    featureTotal: features.length,
    featureDone: features.filter((feature) => feature.status === 'done').length,
    featureFailed: features.filter((feature) => feature.status === 'failed').length,
    milestoneTotal: milestones.length,
    milestoneDone: milestones.filter((milestone) => milestone.status === 'done').length,
    spendUsd: usage.costUsd,
  };
}

/**
 * `POST /factories/:factoryId/missions`. Pins the definition version, creates the mission
 * row (status `planning`), persists a supplied plan, then starts `MissionWorkflow`. A
 * workflow that cannot start leaves the mission `blocked` with a precise reason and returns
 * `503 orchestrator_unavailable` (mirrors work-item creation).
 */
export async function createMissionForApi(
  config: ApiConfig,
  record: FactoryRecord,
  body: CreateMissionBody,
  createdBy: string | null = null,
): Promise<CreatedMission> {
  const sql = getSql();
  const dir = resolveFactoryDir(config, record.key);
  const { commit, dirty } = pinVersion(dir, record.key);
  const missionId = newMissionId();
  const attempt = 1;
  const workflowId = missionWorkflowId(missionId, attempt);

  // Validate the supplied plan before writing anything: an invalid plan is 422, not a row.
  const plan = body.plan
    ? planIdentity(body.plan, {
        missionId,
        factory: record.key,
        definitionCommit: commit,
        title: body.title,
        goal: body.goal,
      })
    : null;

  const created = await createMission(sql, {
    id: missionId,
    factory: record.key,
    factoryId: record.id,
    title: body.title,
    goal: body.goal,
    definitionCommit: commit,
    definitionDirty: dirty,
    factoryRoot: dir,
    definitionVersion: 'stable',
    workflowId,
    attempt,
    ...(body.budget ? { budget: body.budget } : {}),
    createdBy,
  });

  if (plan) {
    try {
      await persistMissionPlan(sql, missionId, plan, 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateMissionStatus(sql, {
        missionId,
        status: 'failed',
        error: `invalid_mission_plan: ${message}`,
      });
      throw invalidMissionPlan(record.key, [message]);
    }
  }

  const input: MissionWorkflowInput = {
    missionId,
    factory: record.key,
    ...(record.id ? { factoryId: record.id } : {}),
    factoryRoot: dir,
    definitionCommit: commit,
    definitionDirty: dirty,
    title: body.title,
    goal: body.goal,
    ...(plan ? { plan: plan as MissionPlanData, planVersion: 1 } : {}),
    ...(body.budget ? { budget: body.budget as MissionBudgetData } : {}),
    attempt,
  };

  let workflow: CreatedMission['workflow'] = null;
  try {
    workflow = await startMissionWorkflow(input, toOrchestrationConfig(config));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateMissionStatus(sql, {
      missionId,
      status: 'blocked',
      error: `orchestrator_unavailable: ${message}`,
    });
    await appendMissionEvent(sql, {
      missionId,
      type: 'mission.blocked',
      actor: 'api',
      payload: { reason: `orchestrator_unavailable: ${message}`, workflowId },
      dedupeKey: 'orchestrator_unavailable',
    });
    log('error', 'mission_start_failed', { missionId, factory: record.key, message });
    throw new ApiError('orchestrator_unavailable', 503, 'could not start the mission workflow', {
      missionId,
      error: message,
    });
  }

  log('info', 'mission_created', {
    missionId,
    factory: record.key,
    definitionCommit: commit,
    planVersion: plan ? 1 : 0,
    workflowId,
  });

  return {
    mission: await missionSummaryView((await getMission(sql, missionId)) ?? created),
    workflow,
  };
}

export async function listMissionsForApi(
  factory: string,
  filters: ListMissionsFilters = {},
  viewer: Viewer | null = null,
): Promise<MissionSummary[]> {
  if (filters.status !== undefined && !missionStatusSchema.safeParse(filters.status).success) {
    throw invalidRequest(`unknown mission status "${filters.status}"`, {
      status: filters.status,
      allowed: [...MISSION_STATUSES],
    });
  }

  return await listMissions(getSql(), {
    factory,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
    ...(filters.offset !== undefined ? { offset: filters.offset } : {}),
    createdBy: ownerFilter(viewer),
  });
}

/**
 * Resolves a mission by id with owner and factory scope. A foreign or unknown mission is
 * `404 mission_not_found` so existence is not leaked (mirrors work-item detail).
 */
async function loadMissionForApi(
  missionId: string,
  record: FactoryRecord,
  viewer: Viewer | null,
): Promise<Mission> {
  if (!MISSION_ID_RE.test(missionId)) throw missionNotFound(missionId);
  const mission = await getMission(getSql(), missionId);
  if (!mission) throw missionNotFound(missionId);
  if (!canAccess(viewer, mission.createdBy)) throw missionNotFound(missionId);
  if (mission.factory !== record.key) throw missionNotFound(missionId);
  if (record.id && mission.factoryId !== record.id) throw missionNotFound(missionId);
  return mission;
}

function budgetUsageView(
  budget: MissionBudget,
  usage: MissionBudgetUsageRecord,
  exceeded: string | null,
): MissionBudgetUsageView {
  const costExhausted =
    budget.maxCostUsd !== undefined && usage.costUsd >= budget.maxCostUsd;
  const runsExhausted = budget.maxRuns !== undefined && usage.runs >= budget.maxRuns;
  const started = usage.startedAt ? Date.parse(usage.startedAt) : Number.NaN;
  const wallClockHours = Number.isFinite(started)
    ? Math.max(0, (Date.now() - started) / (60 * 60 * 1000))
    : null;
  const wallClockExhausted =
    budget.maxWallClockHours !== undefined &&
    wallClockHours !== null &&
    wallClockHours >= budget.maxWallClockHours;

  return {
    budget,
    spendUsd: usage.costUsd,
    runs: usage.runs,
    startedAt: usage.startedAt,
    remainingUsd:
      budget.maxCostUsd !== undefined
        ? Math.max(0, budget.maxCostUsd - usage.costUsd)
        : null,
    remainingRuns:
      budget.maxRuns !== undefined ? Math.max(0, budget.maxRuns - usage.runs) : null,
    wallClockHours,
    costExhausted,
    runsExhausted,
    wallClockExhausted,
    exhausted: exceeded !== null || costExhausted || runsExhausted || wallClockExhausted,
  };
}

/** `GET /factories/:factoryId/missions/:id`: one response with every projection. */
export async function getMissionDetailForApi(
  record: FactoryRecord,
  missionId: string,
  viewer: Viewer | null = null,
): Promise<MissionDetail> {
  const sql = getSql();
  const mission = await loadMissionForApi(missionId, record, viewer);

  const [
    milestones,
    features,
    checkpoints,
    events,
    validations,
    gates,
    pendingGate,
    workItems,
    usage,
  ] = await Promise.all([
    listMissionMilestones(sql, missionId),
    listMissionFeatures(sql, missionId),
    listMissionCheckpoints(sql, missionId),
    listMissionEvents(sql, missionId),
    listMissionValidations(sql, missionId),
    listMissionGates(sql, missionId),
    getPendingMissionGate(sql, missionId),
    listMissionWorkItems(sql, missionId),
    missionBudgetUsage(sql, missionId),
  ]);

  return {
    mission: {
      ...mission,
      featureTotal: features.length,
      featureDone: features.filter((feature) => feature.status === 'done').length,
      featureFailed: features.filter((feature) => feature.status === 'failed').length,
      milestoneTotal: milestones.length,
      milestoneDone: milestones.filter((milestone) => milestone.status === 'done').length,
      spendUsd: usage.costUsd,
    },
    milestones,
    features,
    checkpoints,
    events,
    validations,
    gates,
    pendingGate,
    workItems: workItems.map(summarizeWorkItem),
    budget: {
      budget: mission.budget,
      usage,
      exceeded: missionBudgetExceeded(mission.budget, usage),
    },
    budgetUsage: budgetUsageView(
      mission.budget,
      usage,
      missionBudgetExceeded(mission.budget, usage),
    ),
  };
}

export interface MissionGateDecisionResult {
  missionId: string;
  gate: string;
  decision: MissionPlanDecisionInput['decision'];
  actor: string;
  attempt: number;
  delivery: 'update' | 'signal' | 'failed' | 'none';
  accepted: boolean;
}

const PLAN_DECISION_EVENTS = {
  approve: 'mission.plan.approved',
  reject: 'mission.plan.rejected',
  request_changes: 'mission.plan.changes_requested',
} as const;

/**
 * `POST /factories/:factoryId/missions/:id/gates/plan`: record the decision on the mission
 * gate row, append the audit event, then deliver it to `MissionWorkflow` by Update (Signal
 * fallback). The read model is written first so the UI is consistent even if Temporal is
 * unreachable.
 */
export async function decideMissionPlanGateForApi(
  config: ApiConfig,
  record: FactoryRecord,
  missionId: string,
  request: MissionPlanDecisionInput,
  viewer: Viewer | null = null,
): Promise<MissionGateDecisionResult> {
  const sql = getSql();
  const mission = await loadMissionForApi(missionId, record, viewer);

  const pending = await getPendingMissionGate(sql, missionId);
  if (!pending || pending.gate !== 'plan') throw missionGateNotFound(missionId, 'plan');

  const recorded = await decideMissionGate(sql, {
    missionId,
    gate: pending.gate,
    attempt: pending.attempt,
    decision: request.decision,
    actor: request.actor,
    reason: request.reason ?? null,
    feedback: request.feedback ?? null,
  });
  if (!recorded) {
    throw invalidState(`mission "${missionId}" plan gate was already decided`, {
      missionId,
      gate: pending.gate,
      attempt: pending.attempt,
    });
  }

  await appendMissionEvent(sql, {
    missionId,
    type: PLAN_DECISION_EVENTS[request.decision],
    actor: request.actor,
    payload: {
      gate: pending.gate,
      attempt: pending.attempt,
      decision: request.decision,
      ...(request.reason ? { reason: request.reason } : {}),
      ...(request.feedback ? { feedback: request.feedback } : {}),
    },
    dedupeKey: `plan-decision-${pending.attempt}`,
  });

  const workflowId =
    pending.workflowId ?? mission.workflowId ?? missionWorkflowId(missionId, mission.attempt);

  let delivery: MissionGateDecisionResult['delivery'] = 'none';
  let accepted = false;
  try {
    const result: MissionDecisionDelivery = await submitMissionPlanDecision(
      {
        workflowId,
        decision: request.decision,
        actor: request.actor,
        ...(request.reason ? { reason: request.reason } : {}),
        ...(request.feedback ? { feedback: request.feedback } : {}),
        attempt: pending.attempt,
      },
      toOrchestrationConfig(config),
    );
    delivery = result.delivered;
    accepted = result.accepted;
  } catch (error) {
    delivery = 'failed';
    log('error', 'mission_plan_decision_delivery_failed', {
      missionId,
      workflowId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  log('info', 'mission_plan_decided', {
    missionId,
    decision: request.decision,
    actor: request.actor,
    attempt: pending.attempt,
    delivery,
    accepted,
  });

  return {
    missionId,
    gate: pending.gate,
    decision: request.decision,
    actor: request.actor,
    attempt: pending.attempt,
    delivery,
    accepted,
  };
}

export interface MissionControlResult {
  mission: MissionSummaryView;
  delivery: 'signal' | 'none';
}

export type MissionControlBody = z.infer<typeof missionControlBodySchema>;

/** `POST .../pause`: record the status/event, then Signal `missionPause`. */
export async function pauseMissionForApi(
  config: ApiConfig,
  record: FactoryRecord,
  missionId: string,
  body: MissionControlBody,
  viewer: Viewer | null = null,
): Promise<MissionControlResult & { alreadyPaused: boolean }> {
  const sql = getSql();
  const mission = await loadMissionForApi(missionId, record, viewer);

  if (TERMINAL_MISSION_STATUSES.has(mission.status)) {
    throw invalidState(
      `mission "${missionId}" is ${mission.status}; a terminal mission cannot be paused`,
      { missionId, status: mission.status },
    );
  }

  if (mission.status === 'paused') {
    return {
      mission: await missionSummaryView(mission),
      delivery: 'none',
      alreadyPaused: true,
    };
  }

  const updated = await updateMissionStatus(sql, { missionId, status: 'paused' });
  await appendMissionEvent(sql, {
    missionId,
    type: 'mission.paused',
    actor: body.actor,
    payload: {
      from: mission.status,
      ...(body.reason ? { reason: body.reason } : {}),
    },
  });

  const workflowId = mission.workflowId ?? missionWorkflowId(missionId, mission.attempt);
  let delivery: MissionControlResult['delivery'] = 'none';
  try {
    const signaled = await pauseMission(
      workflowId,
      { actor: body.actor, ...(body.reason ? { reason: body.reason } : {}) },
      toOrchestrationConfig(config),
    );
    delivery = signaled.delivered ? 'signal' : 'none';
  } catch (error) {
    log('error', 'mission_pause_delivery_failed', {
      missionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  log('info', 'mission_paused', {
    missionId,
    actor: body.actor,
    from: mission.status,
    delivery,
  });

  return {
    mission: await missionSummaryView(updated ?? mission),
    delivery,
    alreadyPaused: false,
  };
}

/** `POST .../resume`: record the status/event, then Signal `missionResume`. */
export async function resumeMissionForApi(
  config: ApiConfig,
  record: FactoryRecord,
  missionId: string,
  body: MissionControlBody,
  viewer: Viewer | null = null,
): Promise<MissionControlResult & { alreadyRunning: boolean }> {
  const sql = getSql();
  const mission = await loadMissionForApi(missionId, record, viewer);

  if (mission.status === 'running') {
    return {
      mission: await missionSummaryView(mission),
      delivery: 'none',
      alreadyRunning: true,
    };
  }

  if (mission.status !== 'paused') {
    throw invalidState(
      `mission "${missionId}" is ${mission.status}; only a paused mission can be resumed`,
      { missionId, status: mission.status },
    );
  }

  // A paused mission with an undecided plan gate resumes into `awaiting_plan_approval`,
  // not `running`: the gate still needs a human.
  const pending = await getPendingMissionGate(sql, missionId);
  const nextStatus = pending ? 'awaiting_plan_approval' : 'running';
  const updated = await updateMissionStatus(sql, { missionId, status: nextStatus });
  await appendMissionEvent(sql, {
    missionId,
    type: 'mission.resumed',
    actor: body.actor,
    payload: {
      to: nextStatus,
      ...(body.reason ? { reason: body.reason } : {}),
    },
  });

  const workflowId = mission.workflowId ?? missionWorkflowId(missionId, mission.attempt);
  let delivery: MissionControlResult['delivery'] = 'none';
  try {
    const signaled = await resumeMission(
      workflowId,
      { actor: body.actor, ...(body.reason ? { reason: body.reason } : {}) },
      toOrchestrationConfig(config),
    );
    delivery = signaled.delivered ? 'signal' : 'none';
  } catch (error) {
    log('error', 'mission_resume_delivery_failed', {
      missionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  log('info', 'mission_resumed', { missionId, actor: body.actor, to: nextStatus, delivery });

  return {
    mission: await missionSummaryView(updated ?? mission),
    delivery,
    alreadyRunning: false,
  };
}

export interface CancelMissionResult extends MissionControlResult {
  cancelled: boolean;
  alreadyCancelled: boolean;
  cancelRequestedAt: string | null;
}

/**
 * `POST .../cancel`: cooperative and idempotent. Records the cancellation request once,
 * appends exactly one `mission.cancelled` event, sets the read-model status, then Signals
 * `missionCancel`; the workflow cancels the in-flight child and ends `cancelled`.
 */
export async function cancelMissionForApi(
  config: ApiConfig,
  record: FactoryRecord,
  missionId: string,
  body: MissionControlBody,
  viewer: Viewer | null = null,
): Promise<CancelMissionResult> {
  const sql = getSql();
  const mission = await loadMissionForApi(missionId, record, viewer);

  if (mission.status === 'cancelled') {
    return {
      mission: await missionSummaryView(mission),
      delivery: 'none',
      cancelled: true,
      alreadyCancelled: true,
      cancelRequestedAt: mission.cancelRequestedAt,
    };
  }

  if (TERMINAL_MISSION_STATUSES.has(mission.status)) {
    throw invalidState(
      `mission "${missionId}" is ${mission.status}; a terminal mission cannot be cancelled`,
      { missionId, status: mission.status },
    );
  }

  const reason = body.reason ?? `cancelled by ${body.actor}`;
  await requestMissionCancel(sql, { missionId, actor: body.actor, reason });
  await appendMissionEvent(sql, {
    missionId,
    type: 'mission.cancelled',
    actor: body.actor,
    payload: { reason, from: mission.status },
    dedupeKey: 'cancelled',
  });
  const updated = await updateMissionStatus(sql, { missionId, status: 'cancelled' });

  const workflowId = mission.workflowId ?? missionWorkflowId(missionId, mission.attempt);
  let delivery: MissionControlResult['delivery'] = 'none';
  try {
    const signaled = await cancelMission(
      workflowId,
      { actor: body.actor, reason },
      toOrchestrationConfig(config),
    );
    delivery = signaled.delivered ? 'signal' : 'none';
  } catch (error) {
    log('error', 'mission_cancel_delivery_failed', {
      missionId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  log('info', 'mission_cancelled', { missionId, actor: body.actor, delivery });

  return {
    mission: await missionSummaryView(updated ?? mission),
    delivery,
    cancelled: true,
    alreadyCancelled: false,
    cancelRequestedAt: updated?.cancelRequestedAt ?? mission.cancelRequestedAt,
  };
}

export type MissionRetryFeatureBody = z.infer<typeof missionRetryFeatureBodySchema>;

export interface RetryMissionFeatureResult {
  feature: MissionFeature;
}

/**
 * `POST .../features/:featureId/retry`: reset a finished/failed feature to `pending` and
 * record the request. A `blocked` mission has no live workflow (it returned its outcome), so
 * a retry starts a fresh `MissionWorkflow` attempt at the feature's milestone with the
 * persisted plan. A running/paused mission simply lets its scheduler pick the feature up.
 */
export async function retryMissionFeatureForApi(
  config: ApiConfig,
  record: FactoryRecord,
  missionId: string,
  featureId: string,
  body: MissionRetryFeatureBody,
  viewer: Viewer | null = null,
): Promise<RetryMissionFeatureResult> {
  if (!MISSION_FEATURE_ID_RE.test(featureId)) throw missionFeatureNotFound(missionId, featureId);

  const sql = getSql();
  const mission = await loadMissionForApi(missionId, record, viewer);

  const feature = await getMissionFeature(sql, featureId);
  if (!feature || feature.missionId !== missionId) {
    throw missionFeatureNotFound(missionId, featureId);
  }

  if (feature.status === 'running') {
    throw invalidState(
      `feature "${featureId}" is running; pause the mission before retrying it`,
      { missionId, featureId, status: feature.status },
    );
  }
  if (feature.status === 'done') {
    throw invalidState(`feature "${featureId}" is done; nothing to retry`, {
      missionId,
      featureId,
      status: feature.status,
    });
  }

  const updated = await setMissionFeatureStatus(sql, {
    featureId,
    status: 'pending',
    attempt: feature.attempt + 1,
  });

  let workflow: { workflowId: string; temporalRunId: string } | null = null;
  if (mission.status === 'blocked') {
    if (!mission.plan) {
      throw invalidState(
        `mission "${missionId}" is blocked without a persisted plan; it cannot restart a feature`,
        { missionId, featureId },
      );
    }

    const milestones = await listMissionMilestones(sql, missionId);
    const milestone = milestones.find((entry) => entry.id === feature.milestoneId);
    const milestoneIndex = mission.plan.milestones.findIndex(
      (entry) => entry.id === feature.milestoneId,
    );
    if (!milestone || milestoneIndex < 0) {
      throw invalidState(
        `feature "${featureId}" does not belong to a milestone in the mission plan`,
        { missionId, featureId, milestoneId: feature.milestoneId },
      );
    }

    const attempt = mission.attempt + 1;
    const workflowId = missionWorkflowId(missionId, attempt);
    const planVersion = Math.max(1, mission.planVersion);
    const input: MissionWorkflowInput = {
      missionId,
      factory: mission.factory,
      ...(mission.factoryId ? { factoryId: mission.factoryId } : {}),
      factoryRoot: mission.factoryRoot,
      definitionCommit: mission.definitionCommit,
      definitionDirty: mission.definitionDirty,
      title: mission.title,
      goal: mission.goal,
      plan: mission.plan as MissionPlanData,
      planVersion,
      budget: mission.budget as MissionBudgetData,
      attempt,
      resume: {
        planVersion,
        milestoneIndex,
        featureIndex: 0,
        validationRound: milestone.validationRound,
      },
    };

    await updateMissionStatus(sql, {
      missionId,
      status: 'running',
      currentMilestoneId: feature.milestoneId,
      currentFeatureId: featureId,
      workflowId,
      attempt,
    });

    try {
      workflow = await startMissionWorkflow(input, toOrchestrationConfig(config));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateMissionStatus(sql, {
        missionId,
        status: 'blocked',
        error: `orchestrator_unavailable: ${message}`,
      });
      await appendMissionEvent(sql, {
        missionId,
        type: 'mission.blocked',
        actor: 'api',
        payload: { reason: `orchestrator_unavailable: ${message}`, workflowId },
        dedupeKey: `feature_retry_start_failed:${featureId}:${attempt}`,
      });
      log('error', 'mission_feature_retry_start_failed', {
        missionId,
        featureId,
        message,
      });
      throw new ApiError('orchestrator_unavailable', 503, 'could not restart the mission workflow', {
        missionId,
        featureId,
        error: message,
      });
    }

    log('info', 'mission_feature_retry_restarted', {
      missionId,
      featureId,
      attempt,
      workflowId,
    });
  }

  await appendMissionEvent(sql, {
    missionId,
    featureId,
    type: 'mission.feature.retried',
    actor: body.actor,
    payload: {
      previousStatus: feature.status,
      attempt: (updated ?? feature).attempt,
      ...(workflow ? { workflowId: workflow.workflowId } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
    },
  });

  log('info', 'mission_feature_retried', {
    missionId,
    featureId,
    actor: body.actor,
    previousStatus: feature.status,
    restarted: Boolean(workflow),
  });

  return { feature: updated ?? feature };
}
