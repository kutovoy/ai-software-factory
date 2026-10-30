import { z } from 'zod';
import {
  SpawnNotAllowedError,
  StageGraphError,
  appendWorkItemEvent,
  assignCanaryVersion,
  compileStageGraph,
  createWorkItem as createWorkItemRow,
  evaluateAutonomyRequest,
  foremanAgentName,
  getActiveCanaryRollout,
  getAutonomyState,
  getIntegration,
  getPendingGate,
  getWorkItem,
  latestAutonomyEvent,
  listGateDecisions,
  markWorkItemCancelled,
  listWorkItemEvents,
  listWorkItems,
  loadDefinition,
  newWorkItemId,
  recordGateDecision,
  requestWorkItemCancel,
  resolveAllGates,
  resolveStageConfigs,
  setAutonomyState,
  stageDeclarationsFromDefinition,
  type AgentDef,
  type FactoryDefinition,
  type GateDecisionRequest,
  type LoopStage,
  type WorkItem,
  type WorkItemEvent,
  type WorkItemVersion,
} from '@factory/core';
import {
  cancelWorkItem,
  getSql,
  pauseWorkItemAutonomy,
  startFactoryWorkflow,
  submitGateDecision,
  type FactoryWorkflowInput,
  type GateDecisionValue,
  type LoopStageName,
  type StageGraphSummary,
  type StageNodeSummary,
  workItemWorkflowId,
} from '@factory/orchestration';
import type { ApiConfig } from './config';
import { toOrchestrationConfig } from './config';
import {
  ApiError,
  autonomyRefused,
  benchmarkAttestationMissing,
  definitionInvalid,
  gateNotFound,
  invalidStageGraph,
  invalidRequest,
  invalidState,
  spawnNotAllowed,
  workItemNotFound,
} from './errors';
import { benchmarkGateStatus } from './benchmarks';
import { log } from './logger';
import { resolveFactoryDir } from './factories';
import { pinVersion, resolveRunDefaults } from './runs';

/**
 * Work item routes logic (spec `factory-loop`).
 *
 * Creation compiles the definition's stage graph and resolves every stage's config before
 * the workflow starts, so an unknown stage, a cycle or an unauthorized spawn fails here
 * with a stable code instead of at dispatch time. The work item is persisted first, then
 * `FactoryWorkflow` is started with a workflow id derived from the item id.
 */

const WORK_ITEM_ID_RE = /^wi_[0-9A-HJKMNP-TV-Z]{26}$/;
const LOOP_STAGES = ['triage', 'spec', 'plan', 'implement', 'review', 'verify', 'ship'] as const;
const GATE_DECISIONS = ['approve', 'reject', 'request_changes'] as const;

export const createWorkItemBodySchema = z
  .object({
    factory: z.string().min(1),
    title: z.string().min(1).max(200),
    type: z.enum(['task', 'bug', 'incident', 'pr_review']).optional(),
    source: z.enum(['forge', 'slack', 'cron', 'manual']).optional(),
    sourceRef: z.record(z.string(), z.unknown()).optional(),
    parentId: z.string().regex(WORK_ITEM_ID_RE).optional(),
    /** Seed prompt for stage runs; defaults to the title. */
    prompt: z.string().max(8000).optional(),
    harness: z.enum(['opencode', 'claude-code', 'codex', 'gemini', 'generic-cli', 'fake']).optional(),
    model: z.string().min(1).optional(),
    runner: z.enum(['local-docker', 'local-process', 'fake']).optional(),
    /**
     * ADR-022: hand the pull request to the merge queue instead of merging it in `ship`.
     * Defaults to the factory's GitHub integration setting.
     */
    mergeQueue: z.boolean().optional(),
  })
  .strict();

export type CreateWorkItemBody = z.infer<typeof createWorkItemBodySchema>;

export const gateDecisionBodySchema = z
  .object({
    decision: z.enum(GATE_DECISIONS),
    actor: z.string().min(1).max(120),
    reason: z.string().max(2000).optional(),
    feedback: z.string().max(4000).optional(),
  })
  .strict();

export const autonomyBodySchema = z
  .object({
    factory: z.string().min(1),
    enabled: z.boolean(),
    actor: z.string().min(1).max(120),
    reason: z.string().min(1).max(2000),
    override: z
      .object({ actor: z.string().min(1).max(120), reason: z.string().min(1).max(2000) })
      .strict()
      .optional(),
  })
  .strict();

export type AutonomyBody = z.infer<typeof autonomyBodySchema>;

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
  /** Canary routing (ADR-021): the version this item runs and the rollout that chose it. */
  definitionVersion: WorkItemVersion;
  canaryRolloutId: string | null;
  prUrl: string | null;
  prNumber: number | null;
  loopCount: number;
  cancelRequestedAt: string | null;
  cancelActor: string | null;
  cancelReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function summarize(item: WorkItem): WorkItemSummary {
  return {
    id: item.id,
    factory: item.factory,
    type: item.type,
    source: item.source,
    sourceRef: item.sourceRef,
    title: item.title,
    stage: item.stage,
    status: item.status,
    parentId: item.parentId,
    definitionCommit: item.definitionCommit,
    definitionVersion: item.definitionVersion,
    canaryRolloutId: item.canaryRolloutId,
    prUrl: item.prUrl,
    prNumber: item.prNumber,
    loopCount: item.loopCount,
    cancelRequestedAt: item.cancelRequestedAt ?? null,
    cancelActor: item.cancelActor ?? null,
    cancelReason: item.cancelReason ?? null,
    createdAt: item.createdAt ?? null,
    updatedAt: item.updatedAt ?? null,
  };
}

interface CompiledLoop {
  definition: FactoryDefinition;
  graph: ReturnType<typeof compileStageGraph>;
  configs: ReturnType<typeof resolveStageConfigs>;
  stageGraph: StageGraphSummary;
  gates: Record<string, string>;
}

/** Compiles the definition's stage graph and resolves per-stage configs (spawnableBy). */
function compileLoopAt(dir: string, factory: string): CompiledLoop {
  const { definition, errors } = loadDefinition(dir);
  if (!definition) {
    // A bad stage graph is reported with its own code (spec: `invalid_stage_graph`).
    const stageError = errors.find((error) => error.code === 'invalid_stage_graph');
    if (stageError) throw invalidStageGraph(stageError.pointer, stageError.message);
    throw definitionInvalid(factory, errors);
  }

  const agents = definition.resources
    .filter((resource) => resource.kind === 'agent')
    .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));

  let graph: ReturnType<typeof compileStageGraph>;
  try {
    graph = compileStageGraph(stageDeclarationsFromDefinition(definition.manifest, agents));
  } catch (error) {
    if (error instanceof StageGraphError) throw invalidStageGraph(error.node, error.message);
    throw error;
  }

  let configs: ReturnType<typeof resolveStageConfigs>;
  try {
    configs = resolveStageConfigs(graph, {
      manifest: definition.manifest,
      agents,
      spawner: foremanAgentName(agents),
    });
  } catch (error) {
    if (error instanceof SpawnNotAllowedError) {
      throw spawnNotAllowed(error.stage, error.agent, error.spawner);
    }
    throw error;
  }

  const nodes: StageNodeSummary[] = graph.nodes.map((node) => {
    const stageConfig = configs[node.name];
    return {
      name: node.name,
      needs: [...node.needs],
      agent: node.agent,
      reviewers: node.reviewers,
      gate: stageConfig.gate,
      gateSource: stageConfig.gateSource,
      gateStage: stageConfig.gateStage,
      harness: stageConfig.harness?.type ?? null,
      model: stageConfig.model,
      runner: stageConfig.runner as StageNodeSummary['runner'],
      tools: stageConfig.tools,
    };
  });

  const gates: Record<string, string> = {};
  for (const node of graph.nodes) gates[node.name] = configs[node.name].gate;

  return {
    definition,
    graph,
    configs,
    stageGraph: { order: [...graph.order], fanOut: { ...graph.fanOut }, nodes },
    gates,
  };
}

export interface CreatedWorkItem {
  workItem: WorkItemSummary;
  workflow: { workflowId: string; temporalRunId: string } | null;
}

export async function createWorkItemForApi(
  config: ApiConfig,
  body: CreateWorkItemBody,
): Promise<CreatedWorkItem> {
  const factory = body.factory;
  const sql = getSql();
  const workItemId = newWorkItemId();

  // Canary routing (ADR-021): assign once, at creation, by a deterministic hash of the
  // item id. A candidate item runs the materialised candidate tree and pins its commit, so
  // every stage of the item stays on one version.
  const activeCanary = await getActiveCanaryRollout(sql, factory);
  let canary: { rolloutId: string; root: string; commit: string } | null = null;
  if (
    activeCanary &&
    assignCanaryVersion(workItemId, activeCanary.canaryPercent) === 'candidate'
  ) {
    if (activeCanary.candidateRoot && activeCanary.candidateCommit) {
      canary = {
        rolloutId: activeCanary.id,
        root: activeCanary.candidateRoot,
        commit: activeCanary.candidateCommit,
      };
    } else {
      // A broken rollout must not block new work: fall back to stable and say so.
      log('error', 'canary_candidate_unavailable', {
        factory,
        rolloutId: activeCanary.id,
        workItemId,
        reason: 'the active rollout has no published candidate tree',
      });
    }
  }

  const dir = canary?.root ?? resolveFactoryDir(config, factory);
  const compiled = compileLoopAt(dir, factory);
  const { commit, dirty } = canary
    ? { commit: canary.commit, dirty: false }
    : pinVersion(dir, factory);
  const definitionVersion: WorkItemVersion = canary ? 'candidate' : 'stable';
  const manifest = compiled.definition.manifest;
  const orchestration = toOrchestrationConfig(config);

  const defaults = resolveRunDefaults(manifest, {
    ...(body.harness ? { harness: body.harness } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.runner ? { runner: body.runner } : {}),
  });

  const state = await getAutonomyState(sql, factory);
  const integration = await getIntegration(sql, factory, 'github');
  const mergeQueue = body.mergeQueue ?? integration?.config.mergeQueue === true;
  const gate = await benchmarkGateStatus(config, factory);
  const benchmarkGateSatisfied =
    gate.satisfied || Boolean(state?.overrideActor && state?.overrideReason);

  const workflowId = workItemWorkflowId(workItemId);
  const firstStage = compiled.graph.order[0] as LoopStageName;
  const sourceRef = body.sourceRef ?? {};
  const prompt =
    body.prompt?.trim() ||
    [
      body.title,
      '',
      `Source: ${body.source ?? 'manual'}`,
      `Factory: ${factory}`,
      `Definition commit: ${commit}`,
      `Definition version: ${definitionVersion}`,
      ...(Object.keys(sourceRef).length > 0 ? [`Context: ${JSON.stringify(sourceRef)}`] : []),
    ].join('\n');

  const input: FactoryWorkflowInput = {
    workItemId,
    factory,
    factoryRoot: dir,
    definitionCommit: commit,
    definitionDirty: dirty,
    title: body.title,
    prompt,
    sourceRef,
    repo: { path: config.repoRoot },
    stageGraph: compiled.stageGraph,
    gates: compiled.gates,
    mergePolicy: manifest.mergePolicy,
    autonomy: {
      enabled: state?.enabled ?? false,
      paused: state?.paused ?? false,
      benchmarkGateSatisfied,
      actor: state?.actor ?? null,
      reason: state?.reason ?? null,
    },
    loopLimit: orchestration.loopLimit,
    gateSlaMs: config.gateSlaMs,
    maxStagesPerRun: orchestration.maxStagesPerRun,
    defaultHarness: defaults.harness,
    ...(body.harness ? { harnessOverride: body.harness } : {}),
    ...(defaults.model ? { defaultModel: defaults.model } : {}),
    defaultRunner: defaults.runner,
    autoAllowPermissions: true,
    permissionTimeoutMs: config.permissionTimeoutMs,
    ...(mergeQueue ? { mergeQueue: true } : {}),
  };

  const item = await createWorkItemRow(sql, {
    id: workItemId,
    factory,
    type: body.type ?? 'task',
    source: body.source ?? 'manual',
    sourceRef,
    title: body.title,
    stage: firstStage as LoopStage,
    parentId: body.parentId ?? null,
    definitionCommit: commit,
    definitionDirty: dirty,
    canaryRolloutId: canary?.rolloutId ?? null,
    definitionVersion,
    workflowId,
    input: {
      stageGraph: compiled.stageGraph.order,
      gates: compiled.gates,
      mergePolicy: manifest.mergePolicy,
      definitionVersion,
      canaryRolloutId: canary?.rolloutId ?? null,
      mergeQueue,
    },
  });

  let workflow: CreatedWorkItem['workflow'] = null;
  try {
    workflow = await startFactoryWorkflow(input, orchestration);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendWorkItemEvent(sql, {
      workItemId,
      type: 'work_item.status',
      stage: firstStage,
      actor: 'api',
      payload: { status: 'blocked', reason: `orchestrator_unavailable: ${message}` },
    });
    log('error', 'work_item_start_failed', { workItemId, factory, message });
    throw new ApiError('orchestrator_unavailable', 503, 'could not start the work item workflow', {
      workItemId,
      error: message,
    });
  }

  if (body.parentId) {
    await appendWorkItemEvent(sql, {
      workItemId: body.parentId,
      type: 'work_item.spawned',
      actor: 'api',
      payload: { childId: workItemId, factory },
    });
  }

  log('info', 'work_item_created', {
    workItemId,
    factory,
    stage: firstStage,
    definitionCommit: commit,
    definitionVersion,
    canaryRolloutId: canary?.rolloutId ?? null,
    mergeQueue,
    workflowId,
  });

  return { workItem: summarize(item), workflow };
}

export interface ListWorkItemsFilters {
  factory?: string;
  stage?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function listWorkItemsForApi(
  filters: ListWorkItemsFilters = {},
): Promise<WorkItemSummary[]> {
  const items = await listWorkItems(getSql(), {
    ...(filters.factory ? { factory: filters.factory } : {}),
    ...(filters.stage ? { stage: filters.stage } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
    ...(filters.offset !== undefined ? { offset: filters.offset } : {}),
  });
  return items.map(summarize);
}

export interface WorkItemDetail {
  workItem: WorkItemSummary;
  events: Awaited<ReturnType<typeof listWorkItemEvents>>;
  gates: Awaited<ReturnType<typeof listGateDecisions>>;
  pendingGate: Awaited<ReturnType<typeof getPendingGate>>;
  workflowId: string;
}

export async function getWorkItemDetail(workItemId: string): Promise<WorkItemDetail> {
  const sql = getSql();
  const item = await getWorkItem(sql, workItemId);
  if (!item) throw workItemNotFound(workItemId);

  const [events, gates, pendingGate] = await Promise.all([
    listWorkItemEvents(sql, workItemId),
    listGateDecisions(sql, workItemId),
    getPendingGate(sql, { workItemId }),
  ]);

  return {
    workItem: summarize(item),
    events,
    gates,
    pendingGate,
    workflowId: workItemWorkflowId(workItemId),
  };
}

export interface GateDecisionResult {
  workItemId: string;
  stage: string;
  decision: GateDecisionValue;
  actor: string;
  attempt: number;
  delivery: 'update' | 'signal' | 'none';
}

/**
 * Records the decision in the read model first (UI/inbox), then delivers it to the waiting
 * stage child as a Temporal Update (Signal fallback). ADR-013: the wait itself is
 * workflow-level, so this route only writes a row and posts a message.
 */
export async function submitGateDecisionForApi(
  config: ApiConfig,
  workItemId: string,
  stage: string,
  request: GateDecisionRequest,
): Promise<GateDecisionResult> {
  if (!(LOOP_STAGES as readonly string[]).includes(stage)) {
    throw invalidRequest(`unknown stage "${stage}"`, {
      stage,
      allowed: [...LOOP_STAGES],
    });
  }

  const sql = getSql();
  const item = await getWorkItem(sql, workItemId);
  if (!item) throw workItemNotFound(workItemId);

  const pending = await getPendingGate(sql, { workItemId, stage });
  if (!pending) throw gateNotFound(workItemId, stage);

  await recordGateDecision(sql, {
    workItemId,
    stage: stage as LoopStage,
    attempt: pending.attempt,
    decision: request.decision,
    actor: request.actor,
    reason: request.reason ?? null,
    feedback: request.feedback ?? null,
    automatic: false,
  });

  let delivery: GateDecisionResult['delivery'] = 'none';
  if (pending.workflowId) {
    try {
      const result = await submitGateDecision(
        {
          workflowId: pending.workflowId,
          stage: stage as LoopStageName,
          decision: request.decision,
          actor: request.actor,
          ...(request.reason ? { reason: request.reason } : {}),
          ...(request.feedback ? { feedback: request.feedback } : {}),
          attempt: pending.attempt,
        },
        toOrchestrationConfig(config),
      );
      delivery = result.delivered;
    } catch (error) {
      log('error', 'gate_delivery_failed', {
        workItemId,
        stage,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log('info', 'gate_decided', {
    workItemId,
    stage,
    decision: request.decision,
    actor: request.actor,
    attempt: pending.attempt,
    delivery,
  });

  return {
    workItemId,
    stage,
    decision: request.decision,
    actor: request.actor,
    attempt: pending.attempt,
    delivery,
  };
}

export interface AutonomyResult {
  factory: string;
  enabled: boolean;
  paused: boolean;
  actor: string | null;
  reason: string | null;
  overrideActor: string | null;
  overrideReason: string | null;
  benchmarkGateRequired: boolean;
  benchmarkGateSatisfied: boolean;
  benchmarkAttestationSatisfied: boolean;
  benchmarkAttestationCode: 'benchmark_attestation_missing' | null;
  signaled: number;
}

/**
 * Enable or pause autonomy (the kill switch). Enabling is refused while
 * `benchmarkGateRequired` is unresolved (no passing, calibrated attestation matches the
 * running commit + configHash) unless an explicit override {actor, reason} is recorded
 * (spec: autonomy policy and kill switch, ADR-018). Pausing always succeeds, forces every
 * gate to `human`, and stops new stage dispatch.
 */
export async function setAutonomyForApi(
  config: ApiConfig,
  body: AutonomyBody,
): Promise<AutonomyResult> {
  const dir = resolveFactoryDir(config, body.factory);
  const { definition, errors } = loadDefinition(dir);
  if (!definition) throw definitionInvalid(body.factory, errors);
  const resolution = resolveAllGates(definition.manifest);
  const sql = getSql();
  const current = await getAutonomyState(sql, body.factory);
  const gate = await benchmarkGateStatus(config, body.factory);

  const decision = evaluateAutonomyRequest({
    resolution,
    request: {
      enabled: body.enabled,
      actor: body.actor,
      reason: body.reason,
      ...(body.override ? { override: body.override } : {}),
    },
    current,
    benchmarkAttestationSatisfied: gate.satisfied,
  });

  if (!decision.allowed) {
    if (gate.required && !gate.satisfied && !body.override) {
      throw benchmarkAttestationMissing(body.factory, gate.definitionCommit, gate.suites);
    }
    throw autonomyRefused(decision.message ?? 'autonomy refused', {
      factory: body.factory,
      benchmarkGateRequired: decision.benchmarkGateRequired,
      benchmarkGateSatisfied: decision.benchmarkGateSatisfied,
    });
  }

  const state = await setAutonomyState(sql, {
    factory: body.factory,
    enabled: body.enabled,
    paused: !body.enabled,
    actor: body.actor,
    reason: body.reason,
    overrideActor: decision.override?.actor ?? null,
    overrideReason: decision.override?.reason ?? null,
    benchmarkGateRequired: resolution.benchmarkGateRequired,
  });

  let signaled = 0;
  if (!body.enabled) {
    const active = await listWorkItems(sql, {
      factory: body.factory,
      status: 'active',
      limit: 200,
    });
    for (const item of active) {
      try {
        await pauseWorkItemAutonomy(
          { workflowId: workItemWorkflowId(item.id), actor: body.actor, reason: body.reason },
          toOrchestrationConfig(config),
        );
        signaled += 1;
      } catch {
        // The workflow may already be finished; the read model remains the truth.
      }
    }
  }

  log('info', body.enabled ? 'autonomy_enabled' : 'autonomy_paused', {
    factory: body.factory,
    actor: body.actor,
    reason: body.reason,
    signaled,
  });

  return {
    factory: state.factory,
    enabled: state.enabled,
    paused: state.paused,
    actor: state.actor,
    reason: state.reason,
    overrideActor: state.overrideActor,
    overrideReason: state.overrideReason,
    benchmarkGateRequired: resolution.benchmarkGateRequired,
    benchmarkGateSatisfied: decision.benchmarkGateSatisfied,
    benchmarkAttestationSatisfied: gate.satisfied,
    benchmarkAttestationCode: gate.code,
    signaled,
  };
}

/* ------------------------------------------------ autonomy read model (1.1) */

export interface AutonomyReadModel {
  factory: string;
  /** The declared policy, resolved from git (never inferred from events). */
  declared: {
    stages: Record<string, { gate: string; source: string }>;
    mergePolicy: string;
    fullyAutonomous: boolean;
    benchmarkGateRequired: boolean;
  };
  enabled: boolean;
  paused: boolean;
  actor: string | null;
  reason: string | null;
  /** Null when autonomy was never changed: no timestamp is invented. */
  updatedAt: string | null;
  overrideActor: string | null;
  overrideReason: string | null;
  /** True once an autonomy_state row exists (enabled or paused at least once). */
  everEnabled: boolean;
  benchmarkAttestation: {
    required: boolean;
    satisfied: boolean;
    code: 'benchmark_attestation_missing' | null;
    reason: string | null;
  };
  /** Newest `autonomy.*` work-item event, as evidence for the read state. */
  lastEvent: {
    type: string;
    actor: string | null;
    reason: string | null;
    at: string | null;
    payload: Record<string, unknown>;
  } | null;
}

function autonomyEvidence(event: WorkItemEvent | null): AutonomyReadModel['lastEvent'] {
  if (!event) return null;
  const reason = typeof event.payload.reason === 'string' ? event.payload.reason : null;
  return {
    type: event.type,
    actor: event.actor,
    reason,
    at: event.createdAt,
    payload: event.payload,
  };
}

/**
 * `GET /autonomy` (task 1.1): the declared policy + the live kill-switch state + the newest
 * `autonomy.*` event as evidence. The console no longer derives autonomy from work-item
 * events. When autonomy was never enabled the response says so (`enabled: false` with a
 * reason) and leaves `updatedAt` null rather than inventing a timestamp.
 */
export async function getAutonomyForApi(
  config: ApiConfig,
  factory: string,
): Promise<AutonomyReadModel> {
  const dir = resolveFactoryDir(config, factory);
  const { definition, errors } = loadDefinition(dir);
  if (!definition) throw definitionInvalid(factory, errors);

  const resolution = resolveAllGates(definition.manifest);
  const sql = getSql();
  const [state, gate, lastEvent] = await Promise.all([
    getAutonomyState(sql, factory),
    benchmarkGateStatus(config, factory),
    latestAutonomyEvent(sql, factory),
  ]);

  return {
    factory,
    declared: {
      stages: Object.fromEntries(
        Object.entries(resolution.stages).map(([stage, entry]) => [
          stage,
          { gate: entry.gate, source: entry.source },
        ]),
      ),
      mergePolicy: resolution.mergePolicy,
      fullyAutonomous: resolution.fullyAutonomous,
      benchmarkGateRequired: resolution.benchmarkGateRequired,
    },
    enabled: state?.enabled ?? false,
    paused: state?.paused ?? false,
    actor: state?.actor ?? null,
    reason: state?.reason ?? (state ? null : 'autonomy has never been enabled for this factory'),
    updatedAt: state?.updatedAt ?? null,
    overrideActor: state?.overrideActor ?? null,
    overrideReason: state?.overrideReason ?? null,
    everEnabled: state !== null,
    benchmarkAttestation: {
      required: gate.required,
      satisfied: gate.satisfied,
      code: gate.code,
      reason: gate.reason,
    },
    lastEvent: autonomyEvidence(lastEvent),
  };
}

/* --------------------------------------------- work item cancel (1.2) */

export const cancelWorkItemBodySchema = z
  .object({
    actor: z.string().min(1).max(120),
    reason: z.string().min(1).max(2000),
  })
  .strict();

export type CancelWorkItemBody = z.infer<typeof cancelWorkItemBodySchema>;

export interface CancelWorkItemResult {
  workItem: WorkItemSummary;
  cancelled: boolean;
  /** True when the item was already `cancelled` (idempotent repeat). */
  alreadyCancelled: boolean;
  /** True when a cancellation request was already recorded by an earlier call. */
  alreadyRequested: boolean;
  cancelRequestedAt: string | null;
  /** Whether the workflow Signal reached Temporal (the read model is the truth regardless). */
  delivery: 'signal' | 'none';
  /** True only for the call that recorded the request. */
  eventRecorded: boolean;
}

/**
 * `POST /work-items/:id/cancel` (task 1.2). Cooperative and idempotent: record the actor +
 * reason + timestamp once, Signal `cancelWorkItem`, and let `FactoryWorkflow` cancel the
 * in-flight stage child and end `cancelled`. A repeat returns the same state and emits no
 * second event; a terminal (`done`) item is refused with `invalid_state`.
 */
export async function cancelWorkItemForApi(
  config: ApiConfig,
  workItemId: string,
  body: CancelWorkItemBody,
): Promise<CancelWorkItemResult> {
  const sql = getSql();
  const item = await getWorkItem(sql, workItemId);
  if (!item) throw workItemNotFound(workItemId);

  if (item.status === 'done') {
    throw invalidState(
      `work item "${workItemId}" is done; only an in-flight item can be cancelled`,
      { workItemId, status: item.status },
    );
  }

  if (item.status === 'cancelled') {
    return {
      workItem: summarize(item),
      cancelled: true,
      alreadyCancelled: true,
      alreadyRequested: false,
      cancelRequestedAt: item.cancelRequestedAt ?? null,
      delivery: 'none',
      eventRecorded: false,
    };
  }

  const recorded = await requestWorkItemCancel(sql, {
    workItemId,
    actor: body.actor,
    reason: body.reason,
    stage: item.stage,
  });

  // `blocked`/`escalated` items have no live workflow to cancel (it already ended); the
  // read model is the only authority left, so record the terminal state directly. The
  // event is deduped, so a late Signal/activity cannot add a second one.
  if (item.status === 'blocked' || item.status === 'escalated') {
    const cancelled = await markWorkItemCancelled(sql, {
      workItemId,
      stage: item.stage,
      actor: body.actor,
      reason: body.reason,
    });
    log('info', 'work_item_cancel_requested', {
      workItemId,
      factory: item.factory,
      actor: body.actor,
      recorded: recorded.requested,
      delivery: 'none',
      terminal: true,
    });
    return {
      workItem: summarize(cancelled),
      cancelled: true,
      alreadyCancelled: false,
      alreadyRequested: recorded.alreadyRequested,
      cancelRequestedAt: cancelled.cancelRequestedAt ?? null,
      delivery: 'none',
      eventRecorded: recorded.requested,
    };
  }

  let delivery: CancelWorkItemResult['delivery'] = 'none';
  try {
    const signaled = await cancelWorkItem(
      workItemWorkflowId(workItemId),
      { actor: body.actor, reason: body.reason },
      toOrchestrationConfig(config),
    );
    delivery = signaled.delivered ? 'signal' : 'none';
  } catch (error) {
    log('error', 'work_item_cancel_delivery_failed', {
      workItemId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  log('info', 'work_item_cancel_requested', {
    workItemId,
    factory: item.factory,
    actor: body.actor,
    recorded: recorded.requested,
    delivery,
  });

  return {
    workItem: summarize(recorded.item),
    cancelled: recorded.item.status === 'cancelled',
    alreadyCancelled: false,
    alreadyRequested: recorded.alreadyRequested,
    cancelRequestedAt: recorded.item.cancelRequestedAt ?? null,
    delivery,
    eventRecorded: recorded.requested,
  };
}
