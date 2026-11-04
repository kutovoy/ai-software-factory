import { z } from 'zod';
import {
  SpawnNotAllowedError,
  StageGraphError,
  appendWorkItemEvent,
  assignCanaryVersion,
  buildValidationContract,
  compileStageGraph,
  createWorkItem as createWorkItemRow,
  evaluateAutonomyRequest,
  foremanAgentName,
  getActiveCanaryRollout,
  getAutonomyState,
  getCanaryRollout,
  getIntegration,
  getPendingGate,
  getWorkItem,
  isRetryableWorkItemStatus,
  latestAutonomyEvent,
  latestWorkItemRetry,
  listGateDecisions,
  markWorkItemCancelled,
  listWorkItemEvents,
  listWorkItems,
  loadDefinition,
  mapGate,
  mapWorkItem,
  modelSchema,
  newWorkItemId,
  recordGateDecision,
  requestWorkItemCancel,
  resolveAllGates,
  retryWorkItem as retryWorkItemRow,
  resolveStageConfigs,
  scanReadiness,
  setAutonomyState,
  setWorkItemStatus,
  stageDeclarationsFromDefinition,
  validationContractSchema,
  type AgentDef,
  type AgentVerdict,
  type FactoryDefinition,
  type GateDecisionRecord,
  type GateDecisionRequest,
  type LoopStage,
  type ValidationContract,
  type ValidationProjection,
  type WorkItem,
  type WorkItemEvent,
  type WorkItemRow,
  type WorkItemVersion,
} from '@factory/core';
import {
  cancelWorkItem,
  getSql,
  pauseWorkItemAutonomy,
  startFactoryWorkflow,
  submitGateDecision,
  type FactoryWorkflowInput,
  type FactoryWorkflowResume,
  type GateDecisionValue,
  type LoopStageName,
  type StageGraphSummary,
  type StageNodeSummary,
  workItemWorkflowId,
} from '@factory/orchestration';
import type { ApiConfig } from './config';
import { toOrchestrationConfig } from './config';
import { canAccess, ownerFilter, type Viewer } from './auth';
import {
  ApiError,
  autonomyRefused,
  benchmarkAttestationMissing,
  definitionInvalid,
  gateNotFound,
  invalidStageGraph,
  invalidRequest,
  invalidState,
  readinessNotReady,
  spawnNotAllowed,
  workItemNotFound,
  workItemNotRetryable,
} from './errors';
import { benchmarkGateStatus } from './benchmarks';
import { log } from './logger';
import { factoryIdForKey, loadFactoryDefinition, resolveFactoryDir } from './factories';
import { pinVersion, resolveRunDefaults } from './runs';
import { assertValidationComplete, projectValidation } from './validation';
import { encodeCursor, type PageCursor } from './cursor';

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
    title: z.string().min(1).max(200),
    type: z.enum(['task', 'bug', 'incident', 'pr_review']).optional(),
    source: z.enum(['forge', 'slack', 'cron', 'manual']).optional(),
    sourceRef: z.record(z.string(), z.unknown()).optional(),
    parentId: z.string().regex(WORK_ITEM_ID_RE).optional(),
    /** Seed prompt for stage runs; defaults to the title. */
    prompt: z.string().max(8000).optional(),
    harness: z.enum(['opencode', 'claude-code', 'codex', 'gemini', 'generic-cli', 'fake']).optional(),
    model: modelSchema.optional(),
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
  /** Internal factory key. */
  factory: string;
  /** Stable `fac_<ulid>` identity of the factory. */
  factoryId: string | null;
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
  /** 1-based item attempt: 1 for the first dispatch, incremented by every retry. */
  attempt: number;
  /** When the item was last retried, or null. */
  retriedAt: string | null;
  /** The workflow currently driving the item (`factory-<id>` or `factory-<id>-a<n>`). */
  workflowId: string | null;
  cancelRequestedAt: string | null;
  cancelActor: string | null;
  cancelReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export function summarize(item: WorkItem): WorkItemSummary {
  return {
    id: item.id,
    factory: item.factory,
    factoryId: item.factoryId,
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
    attempt: item.attempt,
    retriedAt: item.retriedAt ?? null,
    workflowId: item.workflowId ?? null,
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
  const { definition, errors } = loadDefinition(dir, { requireFactoryId: true });
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
  /** Internal factory key resolved from the nested route's `:factoryId`. */
  factory: string,
  body: CreateWorkItemBody,
  /** Owner (`users.id`) from the session; null when auth is off (change `add-console-auth`). */
  createdBy: string | null = null,
  /** Stable `fac_<ulid>` identity of the factory the nested route resolved. */
  factoryId: string | null = null,
): Promise<CreatedWorkItem> {
  const sql = getSql();
  const workItemId = newWorkItemId();
  // Automations and webhooks know only the internal key; resolve the identity from the
  // registry so every row carries it (change `add-factory-identity`).
  const resolvedFactoryId = factoryId ?? (await factoryIdForKey(factory));

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

  // Validation contract (roadmap item 1): built deterministically from the factory's
  // optional block and the target repository, then persisted with the item so a retry
  // keeps the same acceptance criteria. `enforce` stays off unless the factory opts in.
  const validationContract: ValidationContract | null =
    manifest.validation?.enabled !== false
      ? buildValidationContract({
          workItemId,
          factory,
          definitionCommit: commit,
          createdAt: new Date().toISOString(),
          title: body.title,
          repoRoot: config.repoRoot,
          ...(manifest.validation ? { config: manifest.validation } : {}),
        })
      : null;

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
    ...(resolvedFactoryId ? { factoryId: resolvedFactoryId } : {}),
    factoryRoot: dir,
    definitionCommit: commit,
    definitionDirty: dirty,
    title: body.title,
    prompt,
    sourceRef,
    repo: { path: config.repoRoot },
    stageGraph: compiled.stageGraph,
    gates: compiled.gates,
    agentVerdict: manifest.agentVerdict,
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
    ...(validationContract ? { validationContract } : {}),
  };

  const item = await createWorkItemRow(sql, {
    id: workItemId,
    factory,
    ...(resolvedFactoryId ? { factoryId: resolvedFactoryId } : {}),
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
    createdBy,
    input: {
      stageGraph: compiled.stageGraph.order,
      gates: compiled.gates,
      mergePolicy: manifest.mergePolicy,
      definitionVersion,
      canaryRolloutId: canary?.rolloutId ?? null,
      mergeQueue,
      // Creation snapshot reused by a retry so the item keeps its seed prompt and the
      // harness/model/runner it was created with (fix-run-actions).
      prompt,
      harness: defaults.harness,
      ...(defaults.model ? { model: defaults.model } : {}),
      runner: defaults.runner,
      // Persisted contract: the verify gate and the work-item page read it from here.
      ...(validationContract ? { validationContract } : {}),
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
  viewer: Viewer | null = null,
): Promise<WorkItemSummary[]> {
  const items = await listWorkItems(getSql(), {
    ...(filters.factory ? { factory: filters.factory } : {}),
    ...(filters.stage ? { stage: filters.stage } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
    ...(filters.offset !== undefined ? { offset: filters.offset } : {}),
    createdBy: ownerFilter(viewer),
  });
  return items.map(summarize);
}

/* --------------------------------------------------------------- board view */

export interface WorkItemBoardEvent {
  type: string;
  stage: string | null;
  payload: Record<string, unknown>;
  createdAt: string | null;
}

export interface WorkItemBoardCard extends WorkItemSummary {
  /** Newest undecided gate, resolved in the same query as the card. */
  pendingGate: GateDecisionRecord | null;
  /** Only `dispatch.requested` / `review.verdict` events; enough to reconstruct run links. */
  events: WorkItemBoardEvent[];
}

export interface WorkItemBoardResult {
  workItems: WorkItemBoardCard[];
  /** Counts for every status in the factory, independent of the current filter. */
  counts: Record<string, number>;
  total: number;
  nextCursor: string | null;
}

export interface WorkItemBoardFilters {
  statuses?: string[];
  limit?: number;
  cursor?: PageCursor | null;
}

interface BoardRow {
  [key: string]: unknown;
  pending_gate: unknown;
  board_events: unknown;
}

function boardEventsOf(value: unknown): WorkItemBoardEvent[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      type: typeof record.type === 'string' ? record.type : '',
      stage: typeof record.stage === 'string' ? record.stage : null,
      payload:
        record.payload && typeof record.payload === 'object'
          ? (record.payload as Record<string, unknown>)
          : {},
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
    };
  });
}

function pendingGateOf(value: unknown): GateDecisionRecord | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  return mapGate({
    work_item_id: typeof row.work_item_id === 'string' ? row.work_item_id : '',
    stage: typeof row.stage === 'string' ? row.stage : '',
    attempt: Number(row.attempt ?? 1),
    gate: typeof row.gate === 'string' ? row.gate : '',
    workflow_id: typeof row.workflow_id === 'string' ? row.workflow_id : null,
    decision: null,
    actor: typeof row.actor === 'string' ? row.actor : null,
    reason: typeof row.reason === 'string' ? row.reason : null,
    feedback: typeof row.feedback === 'string' ? row.feedback : null,
    verdict: row.verdict ?? null,
    automatic: row.automatic === true,
    requested_at: row.requested_at ?? null,
    sla_at: row.sla_at ?? null,
    decided_at: row.decided_at ?? null,
  });
}

/**
 * One query for the board: work-item summary + newest pending gate + the two event types
 * that reconstruct run links. No per-card detail request (performance plan, Phase 2).
 */
export async function listWorkItemBoardForApi(
  factory: string,
  filters: WorkItemBoardFilters = {},
  viewer: Viewer | null = null,
): Promise<WorkItemBoardResult> {
  const sql = getSql();
  const createdBy = ownerFilter(viewer);
  const limit = Math.min(Math.max(filters.limit ?? 40, 1), 100);
  const statuses =
    filters.statuses && filters.statuses.length > 0 ? filters.statuses : null;
  const cursor = filters.cursor ?? null;

  const rows = (await sql`
    select
      w.*,
      r.retry_count,
      r.retried_at,
      pg.gate as pending_gate,
      ev.events as board_events
    from work_items w
    left join lateral (
      select count(*)::int as retry_count, max(e.created_at) as retried_at
      from work_item_events e
      where e.work_item_id = w.id and e.type = 'work_item.retried'
    ) r on true
    left join lateral (
      select jsonb_build_object(
        'work_item_id', g.work_item_id,
        'stage', g.stage,
        'attempt', g.attempt,
        'gate', g.gate,
        'workflow_id', g.workflow_id,
        'decision', g.decision,
        'actor', g.actor,
        'reason', g.reason,
        'feedback', g.feedback,
        'verdict', g.verdict,
        'automatic', g.automatic,
        'requested_at', g.requested_at,
        'sla_at', g.sla_at,
        'decided_at', g.decided_at
      ) as gate
      from gate_decisions g
      where g.work_item_id = w.id and g.decision is null
      order by g.attempt desc
      limit 1
    ) pg on true
    left join lateral (
      select jsonb_agg(
        jsonb_build_object(
          'type', e.type,
          'stage', e.stage,
          'payload', e.payload,
          'createdAt', e.created_at
        )
        order by e.id
      ) as events
      from work_item_events e
      where e.work_item_id = w.id
        and e.type in ('dispatch.requested', 'review.verdict')
    ) ev on true
    where w.factory = ${factory}
      and (${createdBy}::uuid is null or w.created_by = ${createdBy}::uuid)
      and (${statuses}::text[] is null or w.status = any(${statuses}::text[]))
      and (${statuses}::text[] is not null or w.status <> 'cancelled')
      and (
        ${cursor?.at ?? null}::timestamptz is null
        or w.created_at < ${cursor?.at ?? null}::timestamptz
        or (w.created_at = ${cursor?.at ?? null}::timestamptz and w.id < ${cursor?.id ?? null})
      )
    order by w.created_at desc, w.id desc
    limit ${limit}
  `) as BoardRow[];

  const countRows = (await sql`
    select status, count(*)::int as count
    from work_items
    where factory = ${factory}
      and (${createdBy}::uuid is null or created_by = ${createdBy}::uuid)
    group by status
  `) as { status: string; count: number | string }[];

  const counts: Record<string, number> = {};
  for (const row of countRows) counts[row.status] = Number(row.count);

  const workItems: WorkItemBoardCard[] = rows.map((row) => ({
    ...summarize(mapWorkItem(row as unknown as WorkItemRow)),
    pendingGate: pendingGateOf(row.pending_gate),
    events: boardEventsOf(row.board_events),
  }));

  const last = rows[rows.length - 1];
  const lastAt = last?.created_at;
  const nextCursor =
    rows.length === limit && last
      ? encodeCursor(
          lastAt instanceof Date ? lastAt.toISOString() : String(lastAt),
          String(last.id),
        )
      : null;

  return {
    workItems,
    counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    nextCursor,
  };
}

export interface WorkItemDetail {
  workItem: WorkItemSummary;
  events: Awaited<ReturnType<typeof listWorkItemEvents>>;
  gates: Awaited<ReturnType<typeof listGateDecisions>>;
  pendingGate: Awaited<ReturnType<typeof getPendingGate>>;
  workflowId: string;
  /** Validation contract projected against recorded evidence; null when absent. */
  validation: ValidationProjection | null;
}

export async function getWorkItemDetail(
  workItemId: string,
  viewer: Viewer | null = null,
  factoryId: string | null = null,
): Promise<WorkItemDetail> {
  const sql = getSql();
  const item = await getWorkItem(sql, workItemId);
  if (!item) throw workItemNotFound(workItemId);
  // A member asking for someone else's item gets 404: ownership is not leaked.
  if (!canAccess(viewer, item.createdBy)) throw workItemNotFound(workItemId);
  // A nested route also asserts the item belongs to the factory in the URL.
  if (factoryId && item.factoryId !== factoryId) throw workItemNotFound(workItemId);

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
    // The live workflow is the current attempt's id after a retry.
    workflowId: item.workflowId ?? workItemWorkflowId(workItemId, item.attempt),
    validation: projectValidation(item, events),
  };
}

export interface GateDecisionResult {
  workItemId: string;
  stage: string;
  decision: GateDecisionValue;
  actor: string;
  attempt: number;
  /** Agent verdict recorded with the decision (null for human decisions). */
  verdict: AgentVerdict | null;
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
  viewer: Viewer | null = null,
  factoryId: string | null = null,
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
  if (!canAccess(viewer, item.createdBy)) throw workItemNotFound(workItemId);
  if (factoryId && item.factoryId !== factoryId) throw workItemNotFound(workItemId);

  const pending = await getPendingGate(sql, { workItemId, stage });
  if (!pending) throw gateNotFound(workItemId, stage);

  // Verify gate enforcement (roadmap item 1): an approval is refused while the enforced
  // contract still lacks required evidence. `request_changes`/`reject` stay available.
  if (request.decision === 'approve' && stage === 'verify') {
    assertValidationComplete(item, await listWorkItemEvents(sql, workItemId));
  }

  const recorded = await recordGateDecision(sql, {
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
    verdict: recorded.verdict,
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
  factory: string,
  body: AutonomyBody,
): Promise<AutonomyResult> {
  const dir = resolveFactoryDir(config, factory);
  const { definition, errors } = loadDefinition(dir, { requireFactoryId: true });
  if (!definition) throw definitionInvalid(factory, errors);

  // Readiness gate (roadmap item 2): a factory that opts into `readiness.enforceAutonomy`
  // cannot widen autonomy while its report is below `ready`, unless an explicit override
  // {actor, reason} is recorded. Pausing always succeeds.
  if (body.enabled && definition.manifest.readiness?.enforceAutonomy === true && !body.override) {
    const report = scanReadiness({
      repoRoot: config.repoRoot,
      definition,
      thresholds: definition.manifest.readiness.thresholds,
    });
    if (report.status !== 'ready') throw readinessNotReady(factory, report);
  }

  const resolution = resolveAllGates(definition.manifest);
  const sql = getSql();
  const current = await getAutonomyState(sql, factory);
  const gate = await benchmarkGateStatus(config, factory);

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
      throw benchmarkAttestationMissing(factory, gate.definitionCommit, gate.suites);
    }
    throw autonomyRefused(decision.message ?? 'autonomy refused', {
      factory,
      benchmarkGateRequired: decision.benchmarkGateRequired,
      benchmarkGateSatisfied: decision.benchmarkGateSatisfied,
    });
  }

  const state = await setAutonomyState(sql, {
    factory,
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
      factory,
      status: 'active',
      limit: 200,
    });
    for (const item of active) {
      try {
        await pauseWorkItemAutonomy(
          {
            workflowId: item.workflowId ?? workItemWorkflowId(item.id, item.attempt),
            actor: body.actor,
            reason: body.reason,
          },
          toOrchestrationConfig(config),
        );
        signaled += 1;
      } catch {
        // The workflow may already be finished; the read model remains the truth.
      }
    }
  }

  log('info', body.enabled ? 'autonomy_enabled' : 'autonomy_paused', {
    factory,
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
  const { definition, errors } = loadDefinition(dir, { requireFactoryId: true });
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
  viewer: Viewer | null = null,
  factoryId: string | null = null,
): Promise<CancelWorkItemResult> {
  const sql = getSql();
  const item = await getWorkItem(sql, workItemId);
  if (!item) throw workItemNotFound(workItemId);
  if (!canAccess(viewer, item.createdBy)) throw workItemNotFound(workItemId);
  if (factoryId && item.factoryId !== factoryId) throw workItemNotFound(workItemId);

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
      item.workflowId ?? workItemWorkflowId(workItemId, item.attempt),
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

/* ------------------------------------------- work item retry (fix-run-actions) */

export const retryWorkItemBodySchema = z
  .object({
    actor: z.string().min(1).max(120),
    reason: z.string().max(2000).optional(),
  })
  .strict();

export type RetryWorkItemBody = z.infer<typeof retryWorkItemBodySchema>;

/** A double submit inside this window returns the dispatch the first call started. */
const RETRY_DEDUPE_WINDOW_MS = 60_000;

export interface RetryWorkItemResult {
  workItem: WorkItemSummary;
  /** True when the item is active because of a retry (fresh or deduped). */
  retried: boolean;
  /** True when this call returned the dispatch an earlier retry already started. */
  deduped: boolean;
  previousStatus: string | null;
  /** The item attempt after the retry (1 = first dispatch, so a retry lands on ≥ 2). */
  attempt: number;
  workflow: { workflowId: string; temporalRunId: string | null } | null;
  retriedAt: string | null;
}

/**
 * Per-stage attempt counters reconstructed from the durable read model: the highest gate
 * attempt and the highest run attempt (`run_<item>_<stage>_<n>`) recorded for the item.
 *
 * A retry resumes the loop with these counters, so every child workflow id
 * (`stage-<item>-<stage>-<n>`) and run id is fresh. Reusing an attempt number would point
 * at a closed Temporal workflow and `executeChild` would fail on the duplicate id.
 */
async function recordedStageAttempts(
  sql: ReturnType<typeof getSql>,
  workItemId: string,
): Promise<Record<string, number>> {
  const attempts: Record<string, number> = {};

  const gates = await listGateDecisions(sql, workItemId);
  for (const gate of gates) {
    attempts[gate.stage] = Math.max(attempts[gate.stage] ?? 0, gate.attempt);
  }

  const prefix = `run_${workItemId.slice(3)}_`;
  const rows = (await sql`
    select id from runs where id like ${`${prefix}%`}
  `) as { id: string }[];
  for (const row of rows) {
    const match = /^([a-z]+)_(\d+)(?:_r\d+)?$/.exec(row.id.slice(prefix.length));
    const stage = match?.[1];
    const attempt = match?.[2];
    if (!stage || !attempt) continue;
    attempts[stage] = Math.max(attempts[stage] ?? 0, Number(attempt));
  }

  return attempts;
}

/**
 * Rebuilds the `FactoryWorkflowInput` for a retry from the item, its creation snapshot and
 * the definition. The item stays pinned to its `definitionCommit`; only the run defaults,
 * seed prompt and merge-queue choice come from the snapshot, so a retry keeps the contract
 * the operator originally chose.
 */
async function buildRetryInput(
  config: ApiConfig,
  sql: ReturnType<typeof getSql>,
  item: WorkItem,
  attempt: number,
): Promise<FactoryWorkflowInput> {
  const factory = item.factory;
  const snapshot = item.input ?? {};

  // Keep the persisted validation contract across retries (design item 1: "a retry keeps
  // it"). A snapshot written before the contract existed simply has none.
  const parsedContract = validationContractSchema.safeParse(snapshot.validationContract);
  const validationContract = parsedContract.success ? parsedContract.data : null;

  let dir = resolveFactoryDir(config, factory);
  if (item.canaryRolloutId) {
    const rollout = await getCanaryRollout(sql, item.canaryRolloutId);
    if (rollout?.candidateRoot) {
      dir = rollout.candidateRoot;
    } else {
      log('warn', 'canary_candidate_unavailable', {
        factory,
        rolloutId: item.canaryRolloutId,
        workItemId: item.id,
        reason: 'the rollout has no candidate tree; retrying on the stable definition root',
      });
    }
  }

  const compiled = compileLoopAt(dir, factory);
  const order = compiled.graph.order;
  const stageIndex = order.indexOf(item.stage);
  if (stageIndex < 0) {
    throw invalidState(
      `work item "${item.id}" is at stage "${item.stage}", which is not in factory "${factory}"'s compiled stage graph`,
      { workItemId: item.id, stage: item.stage, stages: [...order] },
    );
  }

  const manifest = compiled.definition.manifest;
  const orchestration = toOrchestrationConfig(config);
  const defaults = resolveRunDefaults(
    manifest,
    {
      ...(typeof snapshot.harness === 'string' ? { harness: snapshot.harness } : {}),
      ...(typeof snapshot.model === 'string' ? { model: snapshot.model } : {}),
      ...(typeof snapshot.runner === 'string' ? { runner: snapshot.runner } : {}),
    } as Parameters<typeof resolveRunDefaults>[1],
  );

  const state = await getAutonomyState(sql, factory);
  const integration = await getIntegration(sql, factory, 'github');
  const mergeQueue = snapshot.mergeQueue === true || integration?.config.mergeQueue === true;
  const gate = await benchmarkGateStatus(config, factory);
  const benchmarkGateSatisfied =
    gate.satisfied || Boolean(state?.overrideActor && state?.overrideReason);

  const prompt =
    typeof snapshot.prompt === 'string' && snapshot.prompt.trim() !== ''
      ? snapshot.prompt
      : [
          item.title,
          '',
          `Source: ${item.source}`,
          `Factory: ${factory}`,
          `Definition commit: ${item.definitionCommit}`,
          `Definition version: ${item.definitionVersion}`,
          ...(Object.keys(item.sourceRef).length > 0
            ? [`Context: ${JSON.stringify(item.sourceRef)}`]
            : []),
        ].join('\n');

  const attempts = await recordedStageAttempts(sql, item.id);
  // Floor for the current stage: every retry advances it by at least one attempt, so a
  // stage whose run/gate rows are missing can never reuse a closed child workflow id.
  attempts[item.stage] = Math.max(attempts[item.stage] ?? 0, attempt - 1);

  const resume: FactoryWorkflowResume = {
    stageIndex,
    loopCount: item.loopCount,
    stagesCompleted: stageIndex,
    attempts,
    currentStage: item.stage,
    ...(item.prUrl ? { prUrl: item.prUrl } : {}),
    ...(item.prNumber ? { prNumber: item.prNumber } : {}),
  };

  return {
    workItemId: item.id,
    factory,
    ...(item.factoryId ? { factoryId: item.factoryId } : {}),
    factoryRoot: dir,
    definitionCommit: item.definitionCommit,
    definitionDirty: item.definitionDirty,
    title: item.title,
    prompt,
    sourceRef: item.sourceRef,
    repo: { path: config.repoRoot },
    stageGraph: compiled.stageGraph,
    gates: compiled.gates,
    agentVerdict: manifest.agentVerdict,
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
    ...(defaults.model ? { defaultModel: defaults.model } : {}),
    defaultRunner: defaults.runner,
    autoAllowPermissions: true,
    permissionTimeoutMs: config.permissionTimeoutMs,
    ...(mergeQueue ? { mergeQueue: true } : {}),
    ...(validationContract ? { validationContract } : {}),
    attempt,
    resume,
  };
}

/**
 * `POST /work-items/:id/retry` (spec `factory-loop` › Work-item retry).
 *
 * Re-opens an escalated/failed/blocked/cancelled item at its current stage, clears the
 * cancellation flags (the cancellation stays in the event log as history), records
 * `work_item.retried` (previous status, actor, reason, attempt) and dispatches the current
 * stage again under a new attempt workflow id (`factory-<itemId>-a<n>`). `active` and `done`
 * are refused with `work_item_not_retryable`; a double submit inside 60 s returns the
 * dispatch the first call started instead of starting a second workflow.
 */
export async function retryWorkItemForApi(
  config: ApiConfig,
  workItemId: string,
  body: RetryWorkItemBody,
  viewer: Viewer | null = null,
  factoryId: string | null = null,
): Promise<RetryWorkItemResult> {
  const sql = getSql();
  const item = await getWorkItem(sql, workItemId);
  if (!item) throw workItemNotFound(workItemId);
  if (!canAccess(viewer, item.createdBy)) throw workItemNotFound(workItemId);
  if (factoryId && item.factoryId !== factoryId) throw workItemNotFound(workItemId);

  const latest = await latestWorkItemRetry(sql, workItemId);

  if (item.status === 'active') {
    const recent =
      latest !== null &&
      latest.retriedAt !== null &&
      Date.now() - Date.parse(latest.retriedAt) <= RETRY_DEDUPE_WINDOW_MS;
    if (recent && latest) {
      log('info', 'work_item_retry_deduped', {
        workItemId,
        factory: item.factory,
        attempt: latest.attempt,
        workflowId: latest.workflowId,
      });
      return {
        workItem: summarize(item),
        retried: true,
        deduped: true,
        previousStatus: latest.previousStatus,
        attempt: latest.attempt,
        workflow: latest.workflowId
          ? { workflowId: latest.workflowId, temporalRunId: null }
          : null,
        retriedAt: latest.retriedAt,
      };
    }
    throw workItemNotRetryable(workItemId, item.status);
  }

  if (!isRetryableWorkItemStatus(item.status)) {
    throw workItemNotRetryable(workItemId, item.status);
  }

  const attempt = (latest?.attempt ?? 1) + 1;
  const workflowId = workItemWorkflowId(workItemId, attempt);
  const input = await buildRetryInput(config, sql, item, attempt);

  const transitioned = await retryWorkItemRow(sql, {
    workItemId,
    stage: item.stage,
    actor: body.actor,
    reason: body.reason ?? null,
    attempt,
    workflowId,
  });

  if (!transitioned.applied) {
    // Lost the row lock to a concurrent retry (or the item turned `done` meanwhile).
    const current = await getWorkItem(sql, workItemId);
    if (!current || current.status === 'done') {
      throw workItemNotRetryable(workItemId, current?.status ?? 'unknown');
    }
    const raced = await latestWorkItemRetry(sql, workItemId);
    log('info', 'work_item_retry_deduped', {
      workItemId,
      factory: item.factory,
      attempt: raced?.attempt ?? attempt,
      workflowId: raced?.workflowId ?? workflowId,
      raced: true,
    });
    return {
      workItem: summarize(current),
      retried: true,
      deduped: true,
      previousStatus: raced?.previousStatus ?? transitioned.previousStatus,
      attempt: raced?.attempt ?? attempt,
      workflow: { workflowId: raced?.workflowId ?? workflowId, temporalRunId: null },
      retriedAt: raced?.retriedAt ?? null,
    };
  }

  let workflow: { workflowId: string; temporalRunId: string };
  try {
    workflow = await startFactoryWorkflow(input, toOrchestrationConfig(config));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The item must not stay `active` with no workflow behind it: restore the status it
    // came from so the operator can retry again.
    await setWorkItemStatus(sql, {
      workItemId,
      status: (transitioned.previousStatus ?? 'escalated') as WorkItem['status'],
      actor: 'api',
      reason: `orchestrator_unavailable: ${message}`,
    });
    log('error', 'work_item_retry_start_failed', {
      workItemId,
      factory: item.factory,
      attempt,
      workflowId,
      message,
    });
    throw new ApiError(
      'orchestrator_unavailable',
      503,
      'could not start the retried work item workflow',
      { workItemId, attempt, workflowId, error: message },
    );
  }

  const fresh = (await getWorkItem(sql, workItemId)) ?? transitioned.item;

  log('info', 'work_item_retried', {
    workItemId,
    factory: item.factory,
    stage: item.stage,
    previousStatus: transitioned.previousStatus,
    actor: body.actor,
    attempt,
    workflowId,
  });

  return {
    workItem: summarize(fresh),
    retried: true,
    deduped: false,
    previousStatus: transitioned.previousStatus,
    attempt,
    workflow,
    retriedAt: fresh.retriedAt ?? null,
  };
}
