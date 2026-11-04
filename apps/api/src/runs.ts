import { randomBytes } from 'node:crypto';
import {
  DefinitionValidationError,
  ModelNotAllowedError,
  assertModelAllowed,
  chooseRouting,
  createVersion,
  modelEnvName,
  resolveModelRef,
  type FactoryDefinition,
  type FactoryManifest,
  type GovernanceConfig,
  type RoutingDef,
  type RunnerDef,
} from '@factory/core';
import {
  buildRunContext,
  finishRun,
  getRun,
  getSql,
  insertRun,
  listProxyAttempts,
  listPermissions,
  listSteps,
  startRun,
  workflowIdFor,
  type RunInput,
  type RunRow,
} from '@factory/orchestration';
import type { TraceMetrics } from '@factory/evals';
import type { ApiConfig } from './config';
import { toOrchestrationConfig } from './config';
import { canAccess, type Viewer } from './auth';
import {
  ApiError,
  definitionInvalid,
  factoryBudgetExhausted,
  invalidRequest,
  modelNotAllowed,
  modelUnresolved,
  runNotFound,
} from './errors';
import { loadFactoryDefinition, resolveFactoryDir } from './factories';
import { log } from './logger';

export interface CreateRunBody {
  factory: string;
  prompt?: string;
  files?: string[];
  harness?: RunInput['harness'];
  model?: string;
  agent?: string;
  runner?: RunInput['runner'];
  title?: string;
  /** Scripted-adapter delay, used by tests to kill the worker mid-run. */
  fakeDelayMs?: number;
}

export interface CreatedRun {
  run: RunRow;
  workflow: { workflowId: string; temporalRunId: string };
  proxy: { baseUrl: string; models: string[]; tokenId?: string; token?: string };
}

function loadOrFail(dir: string, factory: string): FactoryDefinition {
  return loadFactoryDefinition(dir, factory);
}

export { loadOrFail };

/** Pins the definition version. The DB is an index; the commit SHA is the identity. */
export function pinVersion(dir: string, factory: string): { commit: string; dirty: boolean } {
  try {
    const version = createVersion(dir, { allowDirty: true });
    return { commit: version.commit, dirty: version.dirty };
  } catch (error) {
    if (error instanceof DefinitionValidationError) {
      throw definitionInvalid(factory, error.errors);
    }
    throw new ApiError(
      'definition_not_versioned',
      422,
      `factory "${factory}" is not inside a git repository; cannot pin definitionCommit`,
      { factory, error: error instanceof Error ? error.message : String(error) },
    );
  }
}

/** Maps a definition runner name (`local-docker`, `local-process`, …) to a backend. */
export function mapRunnerName(name: string | undefined): RunInput['runner'] {
  if (!name) return 'local-docker';
  if (name.includes('docker')) return 'local-docker';
  if (name.includes('process') || name.includes('local')) return 'local-process';
  return 'local-docker';
}

export interface RunDefaultsBody {
  harness?: RunInput['harness'];
  model?: string;
  runner?: RunInput['runner'];
}

export interface RunDefaults {
  harness: RunInput['harness'];
  model?: string;
  runner: RunInput['runner'];
}

/**
 * Resolves harness/model/runner for a run: explicit body -> definition defaults.
 * Shared by chat/runs and work items so the two paths cannot drift.
 */
export function resolveRunDefaults(
  manifest: FactoryManifest,
  body: RunDefaultsBody,
  env: NodeJS.ProcessEnv = process.env,
  routingOptions: {
    routing?: RoutingDef | null;
    prompt?: string;
    stage?: string;
    governance?: GovernanceConfig | null;
  } = {},
): RunDefaults {
  // An explicit harness (e.g. the smoke/e2e `fake` harness) always wins over routing.
  const routed =
    routingOptions.routing && body.harness !== 'fake'
      ? chooseRouting({
          routing: routingOptions.routing,
          prompt: routingOptions.prompt ?? '',
          stage: routingOptions.stage ?? 'implement',
          env,
        })
      : null;
  const harness =
    body.harness ?? routed?.harness?.type ?? manifest.agentDefaults.harness?.type ?? 'opencode';
  const declared =
    body.model ??
    routed?.model ??
    manifest.agentDefaults.harness?.model ??
    manifest.agentDefaults.model ??
    (harness === 'fake' ? 'fake/fake-model' : undefined);

  if (!declared) {
    throw invalidRequest(
      'this factory declares no model and no harness model; pass `model` explicitly',
      { factory: manifest.name },
    );
  }

  // `env:NAME` is resolved here (ADR-028). The literal reference is never passed upstream:
  // an unresolved model is a refusal, except on the fake harness, which needs no model.
  const resolved = resolveModelRef(declared, env);
  if (resolved.value === null && harness !== 'fake') {
    throw modelUnresolved(resolved.ref, modelEnvName(resolved.ref) ?? resolved.ref);
  }

  const model = resolved.value ?? 'fake/fake-model';
  try {
    assertModelAllowed(routingOptions.governance, model);
  } catch (error) {
    if (error instanceof ModelNotAllowedError) throw modelNotAllowed(error.model, error.allowed);
    throw error;
  }
  const runner = harness === 'fake' ? 'fake' : (body.runner ?? mapRunnerName(manifest.agentDefaults.runner));

  return { harness, model, runner };
}

/** Recorded spend for a factory, used by the factory-wide cap. */
export async function factorySpendUsd(factory: string): Promise<number> {
  const rows = (await getSql()`
    select coalesce(sum(cost_usd), 0)::float8 as spent from runs where factory = ${factory}
  `) as { spent: number }[];
  return Number(rows[0]?.spent ?? 0);
}

/**
 * Refuses new work when the factory's recorded spend has reached its cap. The per-run and
 * per-stage caps are enforced by the runner pump; this is the coarse factory guard.
 */
export async function assertFactoryBudget(
  factory: string,
  manifest: FactoryManifest,
): Promise<void> {
  const cap = manifest.budget?.maxCostUsdPerFactory;
  if (cap === undefined) return;
  const spent = await factorySpendUsd(factory);
  if (spent >= cap) throw factoryBudgetExhausted(factory, cap, spent);
}

export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export async function createRun(
  config: ApiConfig,
  body: CreateRunBody,
  options: { kind: 'chat' | 'run'; retryOf?: string; factoryId?: string | null },
  /** Owner (`users.id`) of the run; null when auth is off (change `add-console-auth`). */
  createdBy: string | null = null,
): Promise<CreatedRun> {
  const factory = body.factory;
  const dir = resolveFactoryDir(config, factory);
  const definition = loadOrFail(dir, factory);
  const { commit, dirty } = pinVersion(dir, factory);

  const manifest = definition.manifest;
  await assertFactoryBudget(factory, manifest);
  const routing = (definition.resources.find((resource) => resource.kind === 'routing')?.doc ??
    null) as RoutingDef | null;
  const defaults = resolveRunDefaults(manifest, body, process.env, {
    ...(routing ? { routing } : {}),
    ...(body.prompt ? { prompt: body.prompt } : {}),
    stage: 'implement',
    ...(manifest.governance ? { governance: manifest.governance } : {}),
  });
  const harness = defaults.harness;
  const model = defaults.model;
  const runner = defaults.runner;

  // Setup commands live on the runner resource named in the definition.
  const runnerResource = definition.resources.find(
    (resource) => resource.kind === 'runner' && resource.name === manifest.agentDefaults.runner,
  );
  const setupCommands = (runnerResource?.doc as RunnerDef | undefined)?.setupCommands;

  if (options.kind === 'chat' && (!body.prompt || body.prompt.trim() === '')) {
    throw invalidRequest('chat requires a non-empty prompt');
  }

  const runId = newRunId();
  const workflowId = workflowIdFor(runId);

  const input: RunInput = {
    runId,
    factory,
    ...(options.factoryId ? { factoryId: options.factoryId } : {}),
    factoryRoot: dir,
    definitionCommit: commit,
    definitionDirty: dirty,
    harness,
    model,
    agent: body.agent,
    runner,
    repo: { path: config.repoRoot, commit },
    prompt: body.prompt ? { text: body.prompt, files: body.files } : null,
    kind: options.kind,
    title: body.title ?? (options.kind === 'chat' ? body.prompt?.slice(0, 80) : undefined),
    // The proxy allowlist is exactly the model this run was pinned to.
    proxyModels: model ? [model] : [],
    fakeDelayMs: body.fakeDelayMs,
    ...(manifest.budget?.maxCostUsdPerRun !== undefined
      ? { maxCostUsd: manifest.budget.maxCostUsdPerRun }
      : {}),
    setupCommands,
    // The workflow owns the permission SLA (ADR-013); pin it into the run input.
    permissionTimeoutMs: config.permissionTimeoutMs,
    ...(options.retryOf ? { retryOf: options.retryOf } : {}),
  };

  await insertRun({
    runId,
    factory,
    ...(options.factoryId ? { factoryId: options.factoryId } : {}),
    definitionCommit: commit,
    definitionDirty: dirty,
    harness,
    model: model ?? null,
    runner,
    kind: options.kind,
    title: input.title ?? null,
    input,
    workflowId,
    createdBy,
  });

  let started: { workflowId: string; temporalRunId: string };
  try {
    started = await startRun(input, toOrchestrationConfig(config));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun({ runId, status: 'error', error: `orchestrator_unavailable: ${message}` });
    log('error', 'run_start_failed', { runId, factory, message });
    throw new ApiError('orchestrator_unavailable', 503, 'could not start the run workflow', {
      runId,
      error: message,
    });
  }

  const run = await getRun(runId);
  if (!run) throw new ApiError('internal_error', 500, 'run row disappeared after insert');

  log('info', 'run_created', {
    runId,
    factory,
    harness,
    runner,
    definitionCommit: commit,
    workflowId: started.workflowId,
  });

  return {
    run,
    workflow: started,
    proxy: {
      baseUrl: config.proxyPublicUrl,
      models: input.proxyModels,
    },
  };
}

/**
 * Retry a failed/cancelled chat run as a *new* run (spec `run-lifecycle` › Retry as a new run).
 *
 * The original run is immutable: reusing its id would collide with the terminal event and
 * Temporal replay would re-execute non-idempotent activities. Factory stage runs are owned by
 * their work item, so they are refused here.
 */
export async function retryRun(
  config: ApiConfig,
  runId: string,
  viewer: Viewer | null = null,
  /** The factory the nested route resolved; the original run must belong to it. */
  factoryId: string | null = null,
): Promise<{
  run: RunRow;
  workflow?: CreatedRun['workflow'];
  proxy?: CreatedRun['proxy'];
  retryOf: string;
  deduped: boolean;
}> {
  const original = await assertRunAccess(runId, viewer, factoryId);

  if (original.kind !== 'chat') {
    throw new ApiError(
      'run_not_retryable',
      409,
      'only chat runs can be retried; factory stage runs belong to their work item',
      { runId, kind: original.kind },
    );
  }
  if (original.status !== 'error' && original.status !== 'cancelled') {
    throw new ApiError('run_not_retryable', 409, `a ${original.status} run cannot be retried`, {
      runId,
      status: original.status,
    });
  }

  // Double-submit guard: a retry created within the window is returned instead of a second run.
  const sql = getSql();
  const existing = (await sql`
    select id from runs
    where input->>'retryOf' = ${runId}
      and created_at > now() - interval '60 seconds'
    order by created_at desc
    limit 1
  `) as { id: string }[];
  if (existing[0]) {
    const child = await getRun(existing[0].id);
    if (child) return { run: child, retryOf: runId, deduped: true };
  }

  const input = original.input as RunInput;
  const created = await createRun(
    config,
    {
      factory: original.factory,
      prompt: input.prompt?.text ?? '',
      files: input.prompt?.files,
      title: input.title ?? undefined,
      harness: original.harness as RunInput['harness'],
      model: original.model ?? undefined,
      runner: original.runner as RunInput['runner'],
      agent: input.agent,
    },
    { kind: 'chat', retryOf: runId, ...(factoryId ? { factoryId } : {}) },
    original.created_by ?? null,
  );

  return {
    run: created.run,
    workflow: created.workflow,
    proxy: created.proxy,
    retryOf: runId,
    deduped: false,
  };
}

/**
 * `run_<ulid>_<stage>_<attempt>[_r<n>]` is the orchestrator's `stageRunId` scheme; the
 * embedded ULID is the work item id without its `wi_` prefix. Chat runs never match.
 */
const STAGE_RUN_ID_RE = /^run_([0-9A-HJKMNP-TV-Z]{26})_[a-z]+_\d+(?:_r\d+)?$/;

/** The work item that owns a factory stage run, or null for a chat run. */
export function workItemIdForRun(row: Pick<RunRow, 'id' | 'kind'>): string | null {
  if (row.kind !== 'run') return null;
  const match = STAGE_RUN_ID_RE.exec(row.id);
  return match?.[1] ? `wi_${match[1]}` : null;
}

/**
 * Owner of a run: a chat run carries `created_by`; a stage run inherits its work item's
 * owner (the column stays null for stage runs).
 */
export async function runOwnerId(row: RunRow): Promise<string | null> {
  if (row.created_by) return row.created_by;
  const workItemId = workItemIdForRun(row);
  if (!workItemId) return null;
  const rows = (await getSql()`
    select created_by from work_items where id = ${workItemId} limit 1
  `) as { created_by: string | null }[];
  return rows[0]?.created_by ?? null;
}

/**
 * Read/mutate guard for run-scoped routes (`/runs/:id`, its events, cancel, permissions).
 * A member asking for someone else's run gets `run_not_found` — existence is not leaked.
 */
export async function assertRunAccess(
  runId: string,
  viewer: Viewer | null,
  /** When the route is nested, the run must belong to that factory identity. */
  factoryId: string | null = null,
): Promise<RunRow> {
  const run = await getRun(runId);
  if (!run) throw runNotFound(runId);
  if (!canAccess(viewer, await runOwnerId(run))) throw runNotFound(runId);
  if (factoryId && run.factory_id !== factoryId) throw runNotFound(runId);
  return run;
}

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
  status: string;
  /** Owning work item for a factory stage run; null for chat runs. */
  workItemId: string | null;
  startedAt: string;
  endedAt: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ListRunsFilters {
  limit?: number;
  offset?: number;
  status?: string;
  factory?: string;
  /**
   * Owner scope (change `add-console-auth`): when set, only runs owned by that user are
   * returned — a chat run's `created_by`, or the owner of the work item behind a stage run.
   * Admins pass `null` and see everything.
   */
  createdBy?: string | null;
}

/**
 * `run_<ULID>_<stage>_<attempt>` embeds the work item id: stage runs are owned by their
 * work item, so the owner join reads the item id back out of the run id (no extra column).
 * Chat run ids never match a work item, so the `exists` simply fails for them.
 */
/** Read-model query for the run list (spec: newest-first, no Temporal calls). */
export async function listRuns(filters: ListRunsFilters = {}): Promise<RunSummary[]> {
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);
  const offset = Math.max(filters.offset ?? 0, 0);
  const status = filters.status ?? null;
  const factory = filters.factory ?? null;
  const createdBy = filters.createdBy ?? null;

  const rows = (await getSql()`
    select r.* from runs r
    where (${status}::text is null or r.status = ${status})
      and (${factory}::text is null or r.factory = ${factory})
      and (
        ${createdBy}::uuid is null
        or r.created_by = ${createdBy}::uuid
        or exists (
          select 1 from work_items w
          where w.id = 'wi_' || substr(r.id, 5, 26)
            and w.created_by = ${createdBy}::uuid
        )
      )
    order by r.started_at desc
    limit ${limit} offset ${offset}
  `) as RunRow[];

  return rows.map(summarize);
}

export function summarize(row: RunRow): RunSummary {
  return {
    id: row.id,
    factory: row.factory,
    definitionCommit: row.definition_commit,
    definitionDirty: row.definition_dirty,
    harness: row.harness,
    model: row.model,
    runner: row.runner,
    kind: row.kind,
    title: row.title,
    status: row.status,
    workItemId: workItemIdForRun(row),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
  };
}

export async function getRunDetail(
  runId: string,
  viewer: Viewer | null = null,
  factoryId: string | null = null,
): Promise<{
  run: RunRow;
  summary: RunSummary;
  steps: unknown[];
  artifacts: unknown;
  permissions: unknown[];
  pendingPermissions: unknown[];
  proxyAttempts: unknown[];
  retryOf: string | null;
  retriedBy: string | null;
  /** Deterministic trace metrics derived from events + the review verdict. */
  trace: TraceMetrics | null;
}> {
  const run = await getRun(runId);
  if (!run) throw runNotFound(runId);
  if (!canAccess(viewer, await runOwnerId(run))) throw runNotFound(runId);
  if (factoryId && run.factory_id !== factoryId) throw runNotFound(runId);
  const permissions = await listPermissions(runId);
  const input = run.input as RunInput;
  const children = (await getSql()`
    select id from runs
    where input->>'retryOf' = ${runId}
    order by created_at asc
    limit 1
  `) as { id: string }[];

  let trace: TraceMetrics | null = null;
  try {
    trace = (await buildRunContext({ runId, factory: run.factory })).trace;
  } catch {
    // A run may predate the trace fields or have no event log; the detail page still works.
  }

  return {
    run,
    summary: summarize(run),
    steps: await listSteps(runId),
    artifacts: run.artifacts,
    permissions,
    pendingPermissions: permissions.filter(
      (permission) => (permission as { decision: string | null }).decision === null,
    ),
    proxyAttempts: await listProxyAttempts(runId),
    retryOf: input.retryOf ?? null,
    retriedBy: children[0]?.id ?? null,
    trace,
  };
}
