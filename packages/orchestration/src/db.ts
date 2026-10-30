import { SQL } from 'bun';
import { createHash, randomBytes } from 'node:crypto';
import type { RunInput, RunStatus, TerminalStatus } from './types';

/**
 * Postgres access for the worker and the API. No ORM (ADR-010): plain SQL over Bun's
 * `SQL` client, so the read model is trivially inspectable and rebuildable.
 */
let client: SQL | null = null;

export function getSql(databaseUrl = process.env.DATABASE_URL): SQL {
  if (client) return client;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  client = new SQL(databaseUrl, { max: 10, idleTimeout: 30 });
  return client;
}

/** Test hook: replace the singleton (used by integration tests that point at a scratch db). */
export function setSql(next: SQL | null): void {
  client = next;
}

export async function closeSql(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}

export async function pingDb(databaseUrl?: string): Promise<boolean> {
  const sql = getSql(databaseUrl);
  const rows = await sql`select 1 as ok`;
  return rows.length === 1;
}

/** Bun's SQL client returns `jsonb` columns as strings; normalise them on read. */
export function parseJsonb<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/* ------------------------------------------------------------------ runs */

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

export interface CreateRunRow {
  runId: string;
  factory: string;
  definitionCommit: string;
  definitionDirty: boolean;
  harness: string;
  model?: string | null;
  runner: string;
  kind: 'chat' | 'run';
  title?: string | null;
  input: RunInput;
  workflowId: string;
  temporalRunId?: string | null;
}

export async function insertRun(row: CreateRunRow): Promise<void> {
  const sql = getSql();
  await sql`
    insert into runs (
      id, factory, definition_commit, definition_dirty, harness, model, runner, kind,
      title, input, status, workflow_id, temporal_run_id, started_at
    ) values (
      ${row.runId}, ${row.factory}, ${row.definitionCommit}, ${row.definitionDirty},
      ${row.harness}, ${row.model ?? null}, ${row.runner}, ${row.kind}, ${row.title ?? null},
      ${row.input}::jsonb, 'pending', ${row.workflowId},
      ${row.temporalRunId ?? null}, now()
    )
    on conflict (id) do nothing
  `;
}

/**
 * Activity idempotency: a retried `persistRun` must not reset a terminal run.
 */
export async function markRunRunning(input: RunInput, workflowId: string): Promise<void> {
  const sql = getSql();
  await sql`
    insert into runs (
      id, factory, definition_commit, definition_dirty, harness, model, runner, kind,
      title, input, status, workflow_id, started_at
    ) values (
      ${input.runId}, ${input.factory}, ${input.definitionCommit}, ${input.definitionDirty},
      ${input.harness}, ${input.model ?? null}, ${input.runner}, ${input.kind},
      ${input.title ?? null}, ${input}::jsonb, 'running', ${workflowId}, now()
    )
    on conflict (id) do update set
      status = case when runs.status in ('ok','error','cancelled') then runs.status else 'running' end,
      workflow_id = excluded.workflow_id,
      harness = excluded.harness,
      model = excluded.model,
      runner = excluded.runner,
      definition_commit = excluded.definition_commit,
      definition_dirty = excluded.definition_dirty
  `;
}

export async function setRunSessionRef(runId: string, sessionRef: string | null): Promise<void> {
  const sql = getSql();
  await sql`update runs set session_ref = ${sessionRef} where id = ${runId}`;
}

export async function getRun(runId: string): Promise<RunRow | null> {
  const sql = getSql();
  const rows = (await sql`select * from runs where id = ${runId} limit 1`) as RunRow[];
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    input: parseJsonb<Record<string, unknown>>(row.input, {}),
    artifacts: parseJsonb<unknown[]>(row.artifacts, []),
  };
}

export async function finishRun(params: {
  runId: string;
  status: TerminalStatus;
  summary?: string | null;
  error?: string | null;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  artifacts?: unknown;
}): Promise<void> {
  const sql = getSql();
  await sql`
    update runs set
      status = ${params.status},
      summary = ${params.summary ?? null},
      error = ${params.error ?? null},
      ended_at = coalesce(ended_at, now()),
      cost_usd = coalesce(${params.costUsd ?? null}, cost_usd),
      input_tokens = coalesce(${params.inputTokens ?? null}, input_tokens),
      output_tokens = coalesce(${params.outputTokens ?? null}, output_tokens),
      artifacts = coalesce(${params.artifacts ?? null}::jsonb, artifacts)
    where id = ${params.runId}
  `;
}

/* ------------------------------------------------------------- run_steps */

export async function upsertStep(params: {
  runId: string;
  stepId: string;
  kind: string;
  status: 'running' | 'ok' | 'error' | 'cancelled';
  detail?: unknown;
  error?: string | null;
}): Promise<void> {
  const sql = getSql();
  await sql`
    insert into run_steps (run_id, step_id, kind, status, detail, error, started_at, ended_at)
    values (
      ${params.runId}, ${params.stepId}, ${params.kind}, ${params.status},
      ${params.detail === undefined ? null : params.detail}::jsonb,
      ${params.error ?? null}, now(),
      ${params.status === 'running' ? null : new Date()}
    )
    on conflict (run_id, step_id) do update set
      status = excluded.status,
      detail = coalesce(excluded.detail, run_steps.detail),
      error = coalesce(excluded.error, run_steps.error),
      ended_at = excluded.ended_at
  `;
}

/* ---------------------------------------------------------------- events */

export interface EventRow {
  run_id: string;
  seq: number;
  type: string;
  ts: number | string;
  payload: unknown;
  step_id: string | null;
}

export async function listEvents(runId: string, afterSeq = 0, limit = 500): Promise<EventRow[]> {
  const sql = getSql();
  const rows = (await sql`
    select run_id, seq, type, ts, payload, step_id
    from events
    where run_id = ${runId} and seq > ${afterSeq}
    order by seq asc
    limit ${limit}
  `) as EventRow[];
  return rows.map((row) => ({ ...row, payload: parseJsonb<unknown>(row.payload, {}) }));
}

export async function getStep(runId: string, stepId: string): Promise<{ status: string } | null> {
  const sql = getSql();
  const rows = (await sql`
    select status from run_steps where run_id = ${runId} and step_id = ${stepId} limit 1
  `) as { status: string }[];
  return rows[0] ?? null;
}

export async function listSteps(runId: string): Promise<unknown[]> {
  const sql = getSql();
  const rows = (await sql`
    select step_id, kind, status, detail, error, started_at, ended_at
    from run_steps where run_id = ${runId} order by started_at asc
  `) as Record<string, unknown>[];
  return rows.map((row) => ({ ...row, detail: parseJsonb<unknown>(row.detail, null) }));
}

export async function hasTerminalEvent(runId: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    select 1 as found from events
    where run_id = ${runId} and type = 'run.completed' limit 1
  `;
  return rows.length > 0;
}

/* --------------------------------------------------------- cancellation */

/**
 * Cancellation is cooperative: the API records the request in the read model and the pump
 * activity (which may be blocked on the harness) polls it. This survives a worker restart
 * and never relies on Temporal activity cancellation, which would also fire on a graceful
 * worker shutdown and turn a resumable run into a cancelled one.
 */
export async function requestRunCancel(runId: string, reason?: string): Promise<void> {
  const sql = getSql();
  await sql`
    update runs set cancel_requested_at = coalesce(cancel_requested_at, now()),
                    cancel_reason = coalesce(cancel_reason, ${reason ?? null})
    where id = ${runId} and status not in ('ok', 'error', 'cancelled')
  `;
}

export async function isCancelRequested(runId: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    select 1 as requested from runs
    where id = ${runId} and cancel_requested_at is not null limit 1
  `;
  return rows.length > 0;
}

export async function cancelReasonFor(runId: string): Promise<string | null> {
  const sql = getSql();
  const rows = (await sql`
    select cancel_reason from runs where id = ${runId} limit 1
  `) as { cancel_reason: string | null }[];
  return rows[0]?.cancel_reason ?? null;
}

/* ----------------------------------------------------------- permissions */

export async function upsertPermissionRequest(params: {
  runId: string;
  requestId: string;
  action: string;
  detail: unknown;
}): Promise<void> {
  const sql = getSql();
  await sql`
    insert into run_permissions (run_id, request_id, action, detail, decision, requested_at)
    values (${params.runId}, ${params.requestId}, ${params.action},
            ${params.detail}::jsonb, null, now())
    on conflict (run_id, request_id) do update set
      action = excluded.action,
      detail = excluded.detail
  `;
}

export async function setPermissionDecision(params: {
  runId: string;
  requestId: string;
  decision: 'allow' | 'deny' | 'always';
}): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    update run_permissions
    set decision = ${params.decision}, decided_at = now()
    where run_id = ${params.runId} and request_id = ${params.requestId}
    returning request_id
  `;
  return rows.length > 0;
}

export async function readPermissionDecision(
  runId: string,
  requestId: string,
): Promise<'allow' | 'deny' | 'always' | null> {
  const sql = getSql();
  const rows = (await sql`
    select decision from run_permissions
    where run_id = ${runId} and request_id = ${requestId} limit 1
  `) as { decision: 'allow' | 'deny' | 'always' | null }[];
  return rows[0]?.decision ?? null;
}

/** Distinguishes "no such request" (404) from "not decided yet" (pending). */
export async function hasPermissionRequest(runId: string, requestId: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    select 1 as found from run_permissions
    where run_id = ${runId} and request_id = ${requestId} limit 1
  `;
  return rows.length > 0;
}

export async function listPermissions(runId: string): Promise<unknown[]> {
  const sql = getSql();
  const rows = (await sql`
    select request_id, action, detail, decision, requested_at, decided_at
    from run_permissions where run_id = ${runId} order by requested_at asc
  `) as Record<string, unknown>[];
  return rows.map((row) => ({ ...row, detail: parseJsonb<unknown>(row.detail, {}) }));
}

/* ------------------------------------------------------------ proxy tokens */

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Mints a per-run bearer token; only its hash is stored. */
export async function issueProxyToken(params: {
  runId: string;
  models: string[];
}): Promise<{ token: string; tokenId: string }> {
  const sql = getSql();
  const token = `rsk_${randomBytes(24).toString('base64url')}`;
  const tokenId = `pt_${randomBytes(8).toString('hex')}`;
  await sql`
    insert into proxy_tokens (token_hash, token_id, run_id, models, created_at)
    values (${hashToken(token)}, ${tokenId}, ${params.runId},
            ${params.models}::jsonb, now())
  `;
  return { token, tokenId };
}

export interface ProxyTokenRow {
  token_id: string;
  run_id: string;
  models: string[];
  revoked_at: string | null;
}

export async function lookupProxyToken(token: string): Promise<ProxyTokenRow | null> {
  const sql = getSql();
  const rows = (await sql`
    select token_id, run_id, models, revoked_at
    from proxy_tokens where token_hash = ${hashToken(token)} limit 1
  `) as ProxyTokenRow[];
  const row = rows[0];
  if (!row) return null;
  return { ...row, models: parseJsonb<string[]>(row.models, []) };
}

/** Revocation is immediate: the proxy looks the token up on every request. */
export async function revokeProxyTokens(runId: string): Promise<void> {
  const sql = getSql();
  await sql`
    update proxy_tokens set revoked_at = now()
    where run_id = ${runId} and revoked_at is null
  `;
}

/** Attempts are recorded without prompts or credentials (ADR-011). */
export async function recordProxyAttempt(params: {
  runId: string;
  tokenId?: string | null;
  model?: string | null;
  status: number;
  ok: boolean;
  latencyMs: number;
  error?: string | null;
  streamed?: boolean;
}): Promise<void> {
  const sql = getSql();
  await sql`
    insert into proxy_attempts (run_id, token_id, model, status, ok, latency_ms, error, streamed, created_at)
    values (${params.runId}, ${params.tokenId ?? null}, ${params.model ?? null},
            ${params.status}, ${params.ok}, ${params.latencyMs}, ${params.error ?? null},
            ${params.streamed ?? false}, now())
  `;
}

export async function listProxyAttempts(runId: string): Promise<unknown[]> {
  const sql = getSql();
  return await sql`
    select token_id, model, status, ok, latency_ms, error, streamed, created_at
    from proxy_attempts where run_id = ${runId} order by created_at asc
  `;
}
