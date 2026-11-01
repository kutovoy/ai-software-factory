import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DefinitionValidationError,
  createVersion,
  loadDefinition,
  modelEnvName,
  resolveModelRef,
  type FactoryDefinition,
  type FactoryManifest,
  type RunnerDef,
} from '@factory/core';
import {
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
import type { ApiConfig } from './config';
import { toOrchestrationConfig } from './config';
import {
  ApiError,
  definitionInvalid,
  factoryNotFound,
  invalidRequest,
  modelUnresolved,
  runNotFound,
} from './errors';
import { log } from './logger';

const FACTORY_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

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

function resolveFactoryRoot(config: ApiConfig, factory: string): string {
  if (!FACTORY_NAME_RE.test(factory)) {
    throw invalidRequest(`invalid factory name "${factory}"`, { factory });
  }
  const dir = join(config.factoryRoot, factory);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw factoryNotFound(factory);
  return dir;
}

function loadOrFail(dir: string, factory: string): FactoryDefinition {
  const { definition, errors } = loadDefinition(dir);
  if (!definition) throw definitionInvalid(factory, errors);
  return definition;
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
): RunDefaults {
  const harness = body.harness ?? manifest.agentDefaults.harness?.type ?? 'opencode';
  const declared =
    body.model ??
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
  const runner = harness === 'fake' ? 'fake' : (body.runner ?? mapRunnerName(manifest.agentDefaults.runner));

  return { harness, model, runner };
}

export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export async function createRun(
  config: ApiConfig,
  body: CreateRunBody,
  options: { kind: 'chat' | 'run'; retryOf?: string },
): Promise<CreatedRun> {
  const factory = body.factory;
  const dir = resolveFactoryRoot(config, factory);
  const definition = loadOrFail(dir, factory);
  const { commit, dirty } = pinVersion(dir, factory);

  const manifest = definition.manifest;
  const defaults = resolveRunDefaults(manifest, body);
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
    setupCommands,
    // The workflow owns the permission SLA (ADR-013); pin it into the run input.
    permissionTimeoutMs: config.permissionTimeoutMs,
    ...(options.retryOf ? { retryOf: options.retryOf } : {}),
  };

  await insertRun({
    runId,
    factory,
    definitionCommit: commit,
    definitionDirty: dirty,
    harness,
    model: model ?? null,
    runner,
    kind: options.kind,
    title: input.title ?? null,
    input,
    workflowId,
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
): Promise<{
  run: RunRow;
  workflow?: CreatedRun['workflow'];
  proxy?: CreatedRun['proxy'];
  retryOf: string;
  deduped: boolean;
}> {
  const original = await getRun(runId);
  if (!original) throw runNotFound(runId);

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
    { kind: 'chat', retryOf: runId },
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
}

/** Read-model query for the run list (spec: newest-first, no Temporal calls). */
export async function listRuns(filters: ListRunsFilters = {}): Promise<RunSummary[]> {
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);
  const offset = Math.max(filters.offset ?? 0, 0);
  const status = filters.status ?? null;
  const factory = filters.factory ?? null;

  const rows = (await getSql()`
    select * from runs
    where (${status}::text is null or status = ${status})
      and (${factory}::text is null or factory = ${factory})
    order by started_at desc
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

export async function getRunDetail(runId: string): Promise<{
  run: RunRow;
  summary: RunSummary;
  steps: unknown[];
  artifacts: unknown;
  permissions: unknown[];
  pendingPermissions: unknown[];
  proxyAttempts: unknown[];
  retryOf: string | null;
  retriedBy: string | null;
}> {
  const run = await getRun(runId);
  if (!run) throw runNotFound(runId);
  const permissions = await listPermissions(runId);
  const input = run.input as RunInput;
  const children = (await getSql()`
    select id from runs
    where input->>'retryOf' = ${runId}
    order by created_at asc
    limit 1
  `) as { id: string }[];
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
  };
}
