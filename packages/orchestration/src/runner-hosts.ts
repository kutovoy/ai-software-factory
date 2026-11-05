import { randomBytes } from 'node:crypto';
import type {
  RunnerCommandEnvelope,
  RunnerCommandResultEnvelope,
  RunnerCommandType,
  RunnerHostPlatform,
  RunnerHostStatus,
  RunnerMetrics,
  RunnerPreflightRequest,
} from '@factory/runners';
import { getSql, hashToken, parseJsonb } from './db';
import {
  alertDedupeKey,
  evaluateMetricRules,
  type AlertEvaluation,
  type AlertRule,
  type MetricsSample,
} from './runner-alerts';

/**
 * Runner host store (spec `remote-runners`, `runner-observability`).
 *
 * The control plane keeps every remote-runner fact in Postgres: one-time enrollments,
 * hashed agent tokens, the host registry, leases, the outbound command queue, metric
 * samples and alert state. The agent never touches this database — it only speaks HTTP to
 * the API routes in `apps/api/src/runner-agent.ts`.
 */

/* ------------------------------------------------------------------ types */

/**
 * The read-scope subject the store applies. Structurally identical to the API's `Viewer`
 * (`apps/api/src/auth.ts`), but declared here so orchestration does not depend on the API.
 */
export interface RunnerViewer {
  id: string;
  role: string;
  username?: string;
}

/** Members see their own hosts; admins (and the auth-off implicit user) see everything. */
function ownerFilter(viewer: RunnerViewer | null): string | null {
  if (!viewer) return null;
  return viewer.role === 'admin' ? null : viewer.id;
}

export interface RunnerHostRecord {
  id: string;
  name: string;
  owner: string | null;
  tenant: string;
  platform: RunnerHostPlatform;
  arch: string;
  pool: string;
  labels: Record<string, string>;
  maxConcurrent: number;
  agentVersion: string | null;
  status: RunnerHostStatus;
  drain: boolean;
  lastHeartbeat: string | null;
  enrolledAt: string;
  /** Latest heartbeat metrics, mirrored from `runner_metrics`. */
  metrics: RunnerMetrics | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunnerEnrollmentRecord {
  id: string;
  name: string | null;
  platform: RunnerHostPlatform | null;
  arch: string | null;
  pool: string | null;
  labels: Record<string, string>;
  maxConcurrent: number | null;
  owner: string | null;
  preflight: RunnerPreflightRequest | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  hostId: string | null;
}

export type RunnerLeaseState = 'active' | 'released' | 'expired' | 'error';

export interface RunnerLeaseRecord {
  id: string;
  hostId: string;
  runId: string;
  runnerId: string;
  state: RunnerLeaseState;
  createdAt: string;
  expiresAt: string;
  lastHeartbeat: string;
}

export type RunnerCommandStatus = 'pending' | 'claimed' | 'done' | 'error' | 'expired';

export interface RunnerCommandRecord {
  id: string;
  hostId: string;
  type: RunnerCommandType;
  payload: unknown;
  status: RunnerCommandStatus;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  result: unknown;
  error: string | null;
}

/** The list projection: host plus the aggregates the Runners page renders. */
export interface RunnerHostView extends RunnerHostRecord {
  activeLeases: number;
  latestMetrics: RunnerMetrics | null;
  firingAlerts: number;
}

export interface RunnerAlertView {
  id: string;
  hostId: string;
  hostName: string | null;
  ruleId: string;
  metric: string;
  severity: 'warning' | 'critical';
  state: 'firing' | 'acknowledged' | 'resolved' | 'silenced';
  value: number | null;
  message: string;
  dedupeKey: string;
  firstSeen: string;
  lastSeen: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  silencedUntil: string | null;
  resolvedAt: string | null;
}

export interface RunnerMetricSample {
  capturedAt: string;
  cpuPercent: number | null;
  memoryUsedPercent: number | null;
  diskUsedPercent: number | null;
  metrics: RunnerMetrics;
}

export interface RunnerAlertRuleRecord extends AlertRule {
  createdAt: string;
}

export const DEFAULT_ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

/** A refused enrollment exchange: unknown, used or expired token, or a taken host name. */
export class RunnerEnrollmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerEnrollmentError';
  }
}

/* --------------------------------------------------------------- helpers */

function rid(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonb(value: unknown): string {
  return JSON.stringify(value ?? {});
}

/**
 * Postgres array literal. Bun binds a JS array as a comma-joined string, which is not a
 * valid `text[]` literal, so the array is rendered explicitly (elements quoted + escaped).
 */
function textArray(values: string[]): string {
  const elements = values.map(
    (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
  );
  return `{${elements.join(',')}}`;
}

function toHost(row: Record<string, unknown>): RunnerHostRecord {
  const metrics = parseJsonb<RunnerMetrics | null>(row.metrics, null);
  return {
    id: String(row.id),
    name: String(row.name),
    owner: (row.owner as string | null) ?? null,
    tenant: String(row.tenant),
    platform: row.platform as RunnerHostPlatform,
    arch: String(row.arch),
    pool: String(row.pool),
    labels: parseJsonb<Record<string, string>>(row.labels, {}),
    maxConcurrent: Number(row.max_concurrent ?? 1),
    agentVersion: (row.agent_version as string | null) ?? null,
    status: row.status as RunnerHostStatus,
    drain: Boolean(row.drain),
    lastHeartbeat: iso(row.last_heartbeat),
    enrolledAt: iso(row.enrolled_at) ?? new Date(0).toISOString(),
    metrics: metrics && typeof metrics === 'object' ? metrics : null,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function toEnrollment(row: Record<string, unknown>): RunnerEnrollmentRecord {
  return {
    id: String(row.id),
    name: (row.name as string | null) ?? null,
    platform: (row.platform as RunnerHostPlatform | null) ?? null,
    arch: (row.arch as string | null) ?? null,
    pool: (row.pool as string | null) ?? null,
    labels: parseJsonb<Record<string, string>>(row.labels, {}),
    maxConcurrent: num(row.max_concurrent),
    owner: (row.owner as string | null) ?? null,
    preflight: parseJsonb<RunnerPreflightRequest | null>(row.preflight, null),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    expiresAt: iso(row.expires_at) ?? new Date(0).toISOString(),
    usedAt: iso(row.used_at),
    hostId: (row.host_id as string | null) ?? null,
  };
}

function toLease(row: Record<string, unknown>): RunnerLeaseRecord {
  return {
    id: String(row.id),
    hostId: String(row.host_id),
    runId: String(row.run_id),
    runnerId: String(row.runner_id),
    state: row.state as RunnerLeaseState,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    expiresAt: iso(row.expires_at) ?? new Date(0).toISOString(),
    lastHeartbeat: iso(row.last_heartbeat) ?? new Date(0).toISOString(),
  };
}

function toCommand(row: Record<string, unknown>): RunnerCommandRecord {
  return {
    id: String(row.id),
    hostId: String(row.host_id),
    type: row.type as RunnerCommandType,
    payload: parseJsonb<unknown>(row.payload, {}),
    status: row.status as RunnerCommandStatus,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    claimedAt: iso(row.claimed_at),
    completedAt: iso(row.completed_at),
    result: parseJsonb<unknown>(row.result, null),
    error: (row.error as string | null) ?? null,
  };
}

function toAlertRule(row: Record<string, unknown>): RunnerAlertRuleRecord {
  return {
    id: String(row.id),
    scope: row.scope as AlertRule['scope'],
    hostId: (row.host_id as string | null) ?? null,
    pool: (row.pool as string | null) ?? null,
    metric: String(row.metric),
    comparison: row.comparison as AlertRule['comparison'],
    threshold: Number(row.threshold),
    durationSeconds: Number(row.duration_seconds ?? 0),
    severity: row.severity as AlertRule['severity'],
    channel: String(row.channel ?? 'inbox'),
    enabled: Boolean(row.enabled),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function toAlert(row: Record<string, unknown>): RunnerAlertView {
  return {
    id: String(row.id),
    hostId: String(row.host_id),
    hostName: (row.host_name as string | null) ?? null,
    ruleId: String(row.rule_id),
    metric: String(row.metric),
    severity: row.severity as RunnerAlertView['severity'],
    state: row.state as RunnerAlertView['state'],
    value: num(row.value),
    message: String(row.message),
    dedupeKey: String(row.dedupe_key),
    firstSeen: iso(row.first_seen) ?? new Date(0).toISOString(),
    lastSeen: iso(row.last_seen) ?? new Date(0).toISOString(),
    acknowledgedAt: iso(row.acknowledged_at),
    acknowledgedBy: (row.acknowledged_by as string | null) ?? null,
    silencedUntil: iso(row.silenced_until),
    resolvedAt: iso(row.resolved_at),
  };
}

/** `1h` / `30m` / `90s` / `7d` → a Postgres interval literal. Defaults to one hour. */
export function windowToInterval(window: string | null | undefined): string {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec((window ?? '').trim().toLowerCase());
  if (!match) return '1 hour';
  const unit = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days' }[match[2] as 's' | 'm' | 'h' | 'd'];
  return `${match[1]} ${unit}`;
}

/* ---------------------------------------------------------- enrollments */

export async function createEnrollment(input: {
  name: string;
  platform: RunnerHostPlatform;
  arch: string;
  pool?: string;
  labels?: Record<string, string>;
  maxConcurrent?: number;
  owner: string | null;
  ttlMs?: number;
}): Promise<{ id: string; token: string; expiresAt: string }> {
  const sql = getSql();
  const id = rid('renr');
  // The plaintext token is returned once; only its SHA-256 hash is stored (design: security).
  const token = `ren_${randomBytes(24).toString('base64url')}`;
  const ttlMs = input.ttlMs ?? DEFAULT_ENROLLMENT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  await sql`
    insert into runner_enrollments
      (id, token_hash, name, platform, arch, pool, labels, max_concurrent, owner, expires_at)
    values (
      ${id}, ${hashToken(token)}, ${input.name}, ${input.platform}, ${input.arch},
      ${input.pool ?? 'default'}, ${jsonb(input.labels ?? {})}::text::jsonb,
      ${input.maxConcurrent ?? 1}, ${input.owner}, ${expiresAt}::timestamptz
    )
  `;
  return { id, token, expiresAt };
}

export async function getEnrollment(id: string): Promise<RunnerEnrollmentRecord | null> {
  const sql = getSql();
  const rows = (await sql`
    select * from runner_enrollments where id = ${id} limit 1
  `) as Record<string, unknown>[];
  return rows[0] ? toEnrollment(rows[0]) : null;
}

export async function getEnrollmentByToken(token: string): Promise<RunnerEnrollmentRecord | null> {
  const sql = getSql();
  const rows = (await sql`
    select * from runner_enrollments where token_hash = ${hashToken(token)} limit 1
  `) as Record<string, unknown>[];
  return rows[0] ? toEnrollment(rows[0]) : null;
}

/** Stores the preflight result; a used or expired token is refused (returns false). */
export async function recordPreflight(
  token: string,
  preflight: RunnerPreflightRequest,
): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    update runner_enrollments
    set preflight = ${jsonb(preflight)}::text::jsonb
    where token_hash = ${hashToken(token)}
      and used_at is null
      and expires_at > now()
    returning id
  `;
  return rows.length > 0;
}

/**
 * Exchanges a one-time enrollment token for a host row and an agent token.
 *
 * The update is the guard: it only marks the enrollment used when it is still unused and
 * unexpired, so two concurrent exchanges cannot both succeed.
 */
export async function exchangeEnrollment(input: {
  token: string;
  name: string;
  platform: RunnerHostPlatform;
  arch: string;
  pool?: string;
  labels?: Record<string, string>;
  maxConcurrent?: number;
  agentVersion?: string;
  hostname?: string;
}): Promise<{ hostId: string; agentToken: string }> {
  const sql = getSql();
  const hostId = rid('rhost');
  const agentToken = `rat_${randomBytes(24).toString('base64url')}`;

  await sql.begin(async (tx) => {
    const claimed = (await tx`
      update runner_enrollments
      set used_at = now(), host_id = ${hostId}
      where token_hash = ${hashToken(input.token)}
        and used_at is null
        and expires_at > now()
      returning *
    `) as Record<string, unknown>[];
    if (claimed.length === 0) {
      throw new RunnerEnrollmentError('enrollment token is unknown, already used or expired');
    }
    const enrollment = toEnrollment(claimed[0]);

    await tx`
      insert into runner_hosts (
        id, name, owner, tenant, platform, arch, pool, labels, max_concurrent,
        agent_version, status, drain, last_heartbeat, enrolled_at, token_hash, metrics
      ) values (
        ${hostId}, ${input.name}, ${enrollment.owner}, 'default', ${input.platform},
        ${input.arch}, ${input.pool ?? enrollment.pool ?? 'default'},
        ${jsonb(input.labels ?? enrollment.labels)}::text::jsonb,
        ${input.maxConcurrent ?? enrollment.maxConcurrent ?? 1},
        ${input.agentVersion ?? null}, 'ready', false, now(), now(),
        ${hashToken(agentToken)}, null
      )
    `;
  });

  return { hostId, agentToken };
}

/* ---------------------------------------------------------------- hosts */

/** Bearer-token lookup for the agent routes: the token is hashed and matched. */
export async function authenticateAgent(token: string): Promise<RunnerHostRecord | null> {
  const sql = getSql();
  const rows = (await sql`
    select * from runner_hosts where token_hash = ${hashToken(token)} limit 1
  `) as Record<string, unknown>[];
  return rows[0] ? toHost(rows[0]) : null;
}

export async function getHostRecord(id: string): Promise<RunnerHostRecord | null> {
  const sql = getSql();
  const rows = (await sql`
    select * from runner_hosts where id = ${id} limit 1
  `) as Record<string, unknown>[];
  return rows[0] ? toHost(rows[0]) : null;
}

/** Owner-scoped host lookup: a member sees only their own hosts, an admin everything. */
export async function getHost(id: string, viewer: RunnerViewer | null): Promise<RunnerHostRecord | null> {
  const host = await getHostRecord(id);
  if (!host) return null;
  const owner = ownerFilter(viewer);
  if (owner !== null && host.owner !== owner) return null;
  return host;
}

export async function listHosts(viewer: RunnerViewer | null): Promise<RunnerHostView[]> {
  const sql = getSql();
  const owner = ownerFilter(viewer);
  const rows = (owner === null
    ? await sql`
        select h.*,
          (select count(*)::int from runner_leases l
            where l.host_id = h.id and l.state = 'active' and l.expires_at > now()) as active_leases,
          (select count(*)::int from runner_alerts a
            where a.host_id = h.id and a.resolved_at is null
              and a.state in ('firing', 'acknowledged')) as firing_alerts
        from runner_hosts h
        order by h.name asc
      `
    : await sql`
        select h.*,
          (select count(*)::int from runner_leases l
            where l.host_id = h.id and l.state = 'active' and l.expires_at > now()) as active_leases,
          (select count(*)::int from runner_alerts a
            where a.host_id = h.id and a.resolved_at is null
              and a.state in ('firing', 'acknowledged')) as firing_alerts
        from runner_hosts h
        where h.owner = ${owner}
        order by h.name asc
      `) as Record<string, unknown>[];

  return rows.map((row) => {
    const host = toHost(row);
    return {
      ...host,
      activeLeases: Number(row.active_leases ?? 0),
      latestMetrics: host.metrics,
      firingAlerts: Number(row.firing_alerts ?? 0),
    };
  });
}

/** Drain stops new leases; running leases finish normally. */
export async function drainHost(id: string, drain: boolean): Promise<RunnerHostRecord | null> {
  const sql = getSql();
  const rows = (await sql`
    update runner_hosts set drain = ${drain}, updated_at = now()
    where id = ${id}
    returning *
  `) as Record<string, unknown>[];
  return rows[0] ? toHost(rows[0]) : null;
}

export async function deleteHost(id: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`delete from runner_hosts where id = ${id} returning id`;
  return rows.length > 0;
}

/**
 * Scheduling: a ready, non-draining host whose active leases are below capacity and whose
 * labels contain every requested pair. Most recently heartbeated host wins.
 */
export async function selectHost(input: {
  platform?: string;
  pool?: string;
  labels?: Record<string, string>;
  tenant?: string;
}): Promise<RunnerHostRecord | null> {
  const sql = getSql();
  const rows = (await sql`
    select h.* from runner_hosts h
    where h.status = 'ready'
      and h.drain = false
      and (${input.platform ?? null}::text is null or h.platform = ${input.platform ?? null})
      and (${input.pool ?? null}::text is null or h.pool = ${input.pool ?? null})
      and (${input.tenant ?? null}::text is null or h.tenant = ${input.tenant ?? null})
      and (select count(*) from runner_leases l
            where l.host_id = h.id and l.state = 'active' and l.expires_at > now()) < h.max_concurrent
      and not exists (
        select 1 from jsonb_each_text(${jsonb(input.labels ?? {})}::text::jsonb) wanted
        where h.labels ->> wanted.key is distinct from wanted.value
      )
    order by h.last_heartbeat desc nulls last
    limit 1
  `) as Record<string, unknown>[];
  return rows[0] ? toHost(rows[0]) : null;
}

/* --------------------------------------------------------------- leases */

export async function createLease(input: {
  hostId: string;
  runId: string;
  runnerId: string;
  ttlMs?: number;
}): Promise<RunnerLeaseRecord> {
  const sql = getSql();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_LEASE_TTL_MS)).toISOString();
  const rows = (await sql`
    insert into runner_leases (id, host_id, run_id, runner_id, state, expires_at, last_heartbeat)
    values (${rid('rlease')}, ${input.hostId}, ${input.runId}, ${input.runnerId}, 'active',
            ${expiresAt}::timestamptz, now())
    on conflict (runner_id) do update set
      host_id = excluded.host_id,
      run_id = excluded.run_id,
      state = 'active',
      expires_at = excluded.expires_at,
      last_heartbeat = now()
    returning *
  `) as Record<string, unknown>[];
  return toLease(rows[0] as Record<string, unknown>);
}

export async function releaseLease(runnerId: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    update runner_leases set state = 'released', last_heartbeat = now()
    where runner_id = ${runnerId} and state = 'active'
    returning id
  `;
  return rows.length > 0;
}

export async function getLeaseByRunnerId(runnerId: string): Promise<RunnerLeaseRecord | null> {
  const sql = getSql();
  const rows = (await sql`
    select * from runner_leases where runner_id = ${runnerId} limit 1
  `) as Record<string, unknown>[];
  return rows[0] ? toLease(rows[0]) : null;
}

/**
 * Agent-facing authorization for artifact presign (ADR-047): the bearer-authenticated host
 * must own an *active, unexpired* lease for the `(runnerId, runId)` pair it asks to upload.
 * A mismatched host or run is refused before any grant is signed.
 */
export async function getActiveLeaseForHost(input: {
  hostId: string;
  runnerId: string;
  runId: string;
}): Promise<RunnerLeaseRecord | null> {
  const sql = getSql();
  const rows = (await sql`
    select * from runner_leases
    where host_id = ${input.hostId}
      and runner_id = ${input.runnerId}
      and run_id = ${input.runId}
      and state = 'active'
      and expires_at > now()
    limit 1
  `) as Record<string, unknown>[];
  return rows[0] ? toLease(rows[0]) : null;
}

export async function listLeases(
  hostId: string,
  options: { state?: RunnerLeaseState; limit?: number } = {},
): Promise<RunnerLeaseRecord[]> {
  const sql = getSql();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const rows = (await sql`
    select * from runner_leases
    where host_id = ${hostId}
      and (${options.state ?? null}::text is null or state = ${options.state ?? null})
    order by created_at desc
    limit ${limit}
  `) as Record<string, unknown>[];
  return rows.map(toLease);
}

/** Marks expired active leases; returns the runner ids the worker must fail. */
export async function expireLeases(): Promise<string[]> {
  const sql = getSql();
  const rows = (await sql`
    update runner_leases set state = 'expired'
    where state = 'active' and expires_at < now()
    returning runner_id
  `) as { runner_id: string }[];
  return rows.map((row) => row.runner_id);
}

/* -------------------------------------------------------------- commands */

export async function enqueueCommand(input: {
  hostId: string;
  type: RunnerCommandType;
  payload: unknown;
  timeoutMs?: number;
}): Promise<{ commandId: string }> {
  const sql = getSql();
  void input.timeoutMs; // Reserved: commands have no per-row timeout column in the MVP.
  const id = rid('rcmd');
  await sql`
    insert into runner_commands (id, host_id, type, payload, status)
    values (${id}, ${input.hostId}, ${input.type}, ${jsonb(input.payload)}::text::jsonb, 'pending')
  `;
  return { commandId: id };
}

/**
 * Claims the oldest pending command for a host. `skip locked` lets several polls of the
 * same host proceed without blocking; `waitMs` long-polls so the agent can hold one HTTP
 * request open instead of hammering the API.
 */
export async function claimCommand(
  hostId: string,
  waitMs = 0,
): Promise<RunnerCommandEnvelope | null> {
  const sql = getSql();
  const deadline = Date.now() + Math.max(0, Math.min(waitMs, 30_000));

  for (;;) {
    const rows = (await sql`
      update runner_commands set status = 'claimed', claimed_at = now()
      where id = (
        select id from runner_commands
        where host_id = ${hostId} and status = 'pending'
        order by created_at asc
        limit 1
        for update skip locked
      )
      returning id, host_id, type, payload, created_at
    `) as Record<string, unknown>[];

    const row = rows[0];
    if (row) {
      return {
        id: String(row.id),
        hostId: String(row.host_id),
        type: row.type as RunnerCommandType,
        payload: parseJsonb<unknown>(row.payload, {}),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
    }

    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function completeCommand(
  id: string,
  input: { ok: boolean; result?: unknown; error?: { code: string; message: string } },
  hostId?: string,
): Promise<boolean> {
  const sql = getSql();
  const errorText = input.ok
    ? null
    : input.error
      ? `${input.error.code}: ${input.error.message}`
      : 'command failed';
  const rows = await sql`
    update runner_commands
    set status = ${input.ok ? 'done' : 'error'},
        completed_at = now(),
        result = ${input.ok ? jsonb(input.result ?? null) : null}::text::jsonb,
        error = ${errorText}
    where id = ${id}
      and status in ('pending', 'claimed')
      and (${hostId ?? null}::text is null or host_id = ${hostId ?? null})
    returning id
  `;
  return rows.length > 0;
}

export async function getCommand(id: string): Promise<RunnerCommandRecord | null> {
  const sql = getSql();
  const rows = (await sql`
    select * from runner_commands where id = ${id} limit 1
  `) as Record<string, unknown>[];
  return rows[0] ? toCommand(rows[0]) : null;
}

/** Polls until the command is terminal or `timeoutMs` elapses (central activity side). */
export async function waitForCommand(
  commandId: string,
  timeoutMs: number,
): Promise<RunnerCommandResultEnvelope> {
  const sql = getSql();
  const deadline = Date.now() + Math.max(0, timeoutMs);

  for (;;) {
    const rows = (await sql`
      select status, result, error from runner_commands where id = ${commandId} limit 1
    `) as { status: RunnerCommandStatus; result: unknown; error: string | null }[];

    const row = rows[0];
    if (!row) {
      return {
        commandId,
        ok: false,
        error: { code: 'command_not_found', message: `no command "${commandId}"` },
      };
    }
    if (row.status === 'done') {
      return {
        commandId,
        ok: true,
        result: parseJsonb<unknown>(row.result, null),
      };
    }
    if (row.status === 'error') {
      return {
        commandId,
        ok: false,
        error: { code: 'command_failed', message: row.error ?? 'command failed' },
      };
    }
    if (row.status === 'expired') {
      return {
        commandId,
        ok: false,
        error: { code: 'command_expired', message: 'command expired before the agent claimed it' },
      };
    }
    if (Date.now() >= deadline) {
      return {
        commandId,
        ok: false,
        error: {
          code: 'command_timeout',
          message: `command "${commandId}" did not complete within ${timeoutMs}ms`,
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/* --------------------------------------------------------------- metrics */

/**
 * Heartbeat ingest: update the host row, append a metrics sample and evaluate rules.
 * The sample is written before evaluation so a duration rule sees the new sample.
 */
export async function recordHeartbeat(
  hostId: string,
  input: { metrics: RunnerMetrics; status?: RunnerHostStatus; leases?: number },
): Promise<void> {
  const sql = getSql();
  const capturedAt = input.metrics.capturedAt || new Date().toISOString();
  const diskUsedPercent =
    input.metrics.disks.length > 0
      ? Math.max(...input.metrics.disks.map((disk) => disk.usedPercent))
      : null;

  await sql`
    update runner_hosts set
      last_heartbeat = now(),
      status = coalesce(${input.status ?? null}, status),
      metrics = ${jsonb(input.metrics)}::text::jsonb,
      agent_version = coalesce(${input.metrics.agentVersion ?? null}, agent_version),
      updated_at = now()
    where id = ${hostId}
  `;

  await sql`
    insert into runner_metrics
      (host_id, captured_at, cpu_percent, memory_used_percent, disk_used_percent, metrics)
    values (
      ${hostId}, ${capturedAt}::timestamptz,
      ${input.metrics.cpuPercent ?? null}, ${input.metrics.memoryUsedPercent ?? null},
      ${diskUsedPercent}, ${jsonb(input.metrics)}::text::jsonb
    )
  `;

  await recordMetricsAndEvaluate(hostId, input.metrics);
}

/** Loads the host, enabled rules and recent samples, evaluates and persists alerts. */
export async function recordMetricsAndEvaluate(
  hostId: string,
  metrics: RunnerMetrics,
): Promise<AlertEvaluation[]> {
  const sql = getSql();
  const host = await getHostRecord(hostId);
  if (!host) return [];

  const rules = await listAlertRules();
  const historyRows = (await sql`
    select captured_at, metrics from runner_metrics
    where host_id = ${hostId}
    order by captured_at desc
    limit 60
  `) as Record<string, unknown>[];

  const history: MetricsSample[] = historyRows.map((row) => ({
    capturedAt: iso(row.captured_at) ?? new Date(0).toISOString(),
    metrics: parseJsonb<RunnerMetrics>(row.metrics, metrics),
  }));

  const evaluations = evaluateMetricRules({ host, metrics, rules, history });
  await applyAlertEvaluations(hostId, evaluations);
  return evaluations;
}

export async function listMetrics(hostId: string, window = '1h'): Promise<RunnerMetricSample[]> {
  const sql = getSql();
  const interval = windowToInterval(window);
  const rows = (await sql`
    select captured_at, cpu_percent, memory_used_percent, disk_used_percent, metrics
    from runner_metrics
    where host_id = ${hostId}
      and captured_at > now() - ${interval}::interval
    order by captured_at asc
  `) as Record<string, unknown>[];
  return rows.map((row) => ({
    capturedAt: iso(row.captured_at) ?? new Date(0).toISOString(),
    cpuPercent: num(row.cpu_percent),
    memoryUsedPercent: num(row.memory_used_percent),
    diskUsedPercent: num(row.disk_used_percent),
    metrics: parseJsonb<RunnerMetrics>(row.metrics, {} as RunnerMetrics),
  }));
}

/* ---------------------------------------------------------------- alerts */

/**
 * Upsert/resolve. The dedupe key is `hostId:ruleId` and the partial unique index keeps one
 * unresolved row per key; an acknowledged or silenced alert keeps its state on refresh so a
 * firing metric does not re-notify the operator.
 */
export async function applyAlertEvaluations(
  hostId: string,
  evaluations: AlertEvaluation[],
): Promise<void> {
  const sql = getSql();
  for (const evaluation of evaluations) {
    const dedupeKey = alertDedupeKey(hostId, evaluation.ruleId);
    if (evaluation.firing) {
      await sql`
        insert into runner_alerts
          (id, host_id, rule_id, metric, severity, state, value, message, dedupe_key,
           first_seen, last_seen)
        values (
          ${rid('ralert')}, ${hostId}, ${evaluation.ruleId}, ${evaluation.metric},
          ${evaluation.severity}, 'firing', ${evaluation.value}, ${evaluation.message},
          ${dedupeKey}, now(), now()
        )
        on conflict (dedupe_key) where resolved_at is null do update set
          last_seen = now(),
          value = excluded.value,
          message = excluded.message,
          severity = excluded.severity,
          state = case
            when runner_alerts.state = 'silenced' and runner_alerts.silenced_until > now()
              then 'silenced'
            when runner_alerts.state = 'acknowledged' then 'acknowledged'
            else 'firing'
          end
      `;
    } else {
      await sql`
        update runner_alerts
        set state = 'resolved', resolved_at = now(), last_seen = now()
        where dedupe_key = ${dedupeKey} and resolved_at is null
      `;
    }
  }
}

export async function listAlerts(
  viewer: RunnerViewer | null,
  options: { state?: RunnerAlertView['state']; limit?: number; hostId?: string } = {},
): Promise<RunnerAlertView[]> {
  const sql = getSql();
  const owner = ownerFilter(viewer);
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const rows = (await sql`
    select a.*, h.name as host_name
    from runner_alerts a
    join runner_hosts h on h.id = a.host_id
    where (${options.state ?? null}::text is null or a.state = ${options.state ?? null})
      and (${options.hostId ?? null}::text is null or a.host_id = ${options.hostId ?? null})
      and (${owner}::text is null or h.owner = ${owner})
    order by a.last_seen desc
    limit ${limit}
  `) as Record<string, unknown>[];
  return rows.map(toAlert);
}

export async function ackAlert(id: string, actor: string): Promise<RunnerAlertView | null> {
  const sql = getSql();
  const updated = await sql`
    update runner_alerts
    set state = 'acknowledged', acknowledged_at = now(), acknowledged_by = ${actor}
    where id = ${id} and resolved_at is null
    returning id
  `;
  if (updated.length === 0) return null;
  return getAlertView(id);
}

export async function silenceAlert(
  id: string,
  until: string,
  actor: string,
): Promise<RunnerAlertView | null> {
  const sql = getSql();
  const updated = await sql`
    update runner_alerts
    set state = 'silenced', silenced_until = ${until}::timestamptz,
        acknowledged_at = coalesce(acknowledged_at, now()),
        acknowledged_by = coalesce(acknowledged_by, ${actor})
    where id = ${id} and resolved_at is null
    returning id
  `;
  if (updated.length === 0) return null;
  return getAlertView(id);
}

export async function getAlertView(id: string): Promise<RunnerAlertView | null> {
  const sql = getSql();
  const rows = (await sql`
    select a.*, h.name as host_name
    from runner_alerts a
    join runner_hosts h on h.id = a.host_id
    where a.id = ${id}
    limit 1
  `) as Record<string, unknown>[];
  return rows[0] ? toAlert(rows[0]) : null;
}

export async function listAlertRules(): Promise<RunnerAlertRuleRecord[]> {
  const sql = getSql();
  const rows = (await sql`
    select * from runner_alert_rules order by metric asc, comparison asc, threshold asc
  `) as Record<string, unknown>[];
  return rows.map(toAlertRule);
}

/** Replaces the rule set atomically: upsert every supplied rule, delete the rest. */
export async function replaceAlertRules(
  rules: Array<Omit<RunnerAlertRuleRecord, 'createdAt'>>,
): Promise<RunnerAlertRuleRecord[]> {
  const sql = getSql();
  await sql.begin(async (tx) => {
    for (const rule of rules) {
      await tx`
        insert into runner_alert_rules
          (id, scope, host_id, pool, metric, comparison, threshold, duration_seconds,
           severity, channel, enabled)
        values (
          ${rule.id}, ${rule.scope}, ${rule.hostId}, ${rule.pool}, ${rule.metric},
          ${rule.comparison}, ${rule.threshold}, ${rule.durationSeconds},
          ${rule.severity}, ${rule.channel}, ${rule.enabled}
        )
        on conflict (id) do update set
          scope = excluded.scope,
          host_id = excluded.host_id,
          pool = excluded.pool,
          metric = excluded.metric,
          comparison = excluded.comparison,
          threshold = excluded.threshold,
          duration_seconds = excluded.duration_seconds,
          severity = excluded.severity,
          channel = excluded.channel,
          enabled = excluded.enabled
      `;
    }
    const ids = rules.map((rule) => rule.id);
    if (ids.length === 0) {
      await tx`delete from runner_alert_rules`;
    } else {
      await tx`delete from runner_alert_rules where id <> all(${textArray(ids)}::text[])`;
    }
  });
  return listAlertRules();
}
