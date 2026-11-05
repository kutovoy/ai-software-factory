import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  DEFAULT_COMMAND_POLL_TIMEOUT_MS,
  type RunnerCommandResultEnvelope,
  type RunnerEnrollmentRequest,
  type RunnerHeartbeatRequest,
  type RunnerHostStatus,
  type RunnerMetrics,
  type RunnerPreflightRequest,
} from '@factory/runners';
import {
  RunnerEnrollmentError,
  authenticateAgent,
  claimCommand,
  completeCommand,
  exchangeEnrollment,
  recordHeartbeat,
  recordPreflight,
  type RunnerHostRecord,
} from '@factory/orchestration';
import type { ApiConfig } from './config';
import { ApiError, invalidRequest } from './errors';
import { API_PREFIX } from './routes';
import { readJsonBody } from './runners';

/**
 * Agent-facing routes (spec `remote-runners` › Agent command protocol).
 *
 * These are registered on the **root** app with the full `/api/v1/...` path, *not* on the
 * auth-protected sub-app: a remote agent has no console session, and `AUTH_REQUIRED=1`
 * must not lock it out. Everything except enroll/preflight is authenticated by a per-host
 * `Authorization: Bearer <agentToken>` header (SHA-256 hash lookup, 401 `agent_unauthorized`).
 */

const HOST_STATUSES = [
  'pending',
  'provisioning',
  'initializing',
  'ready',
  'not_ready',
  'unreachable',
  'maintenance',
  'deleting',
  'error',
] as const satisfies readonly RunnerHostStatus[];

const preflightBodySchema = z
  .object({
    platform: z.enum(['linux', 'windows', 'macos']),
    checks: z.record(
      z
        .object({ ok: z.boolean(), detail: z.string().max(500).optional() })
        .strict(),
    ),
  })
  .strict();

const enrollBodySchema = z
  .object({
    token: z.string().min(1).max(200),
    name: z.string().min(1).max(64),
    platform: z.enum(['linux', 'windows', 'macos']),
    arch: z.string().min(1).max(32),
    pool: z.string().min(1).max(64).optional(),
    labels: z.record(z.string().max(120)).optional(),
    maxConcurrent: z.number().int().min(1).max(64).optional(),
    agentVersion: z.string().max(64).optional(),
    hostname: z.string().max(255).optional(),
  })
  .strict();

const diskSchema = z
  .object({
    mount: z.string().max(255),
    totalBytes: z.number(),
    usedBytes: z.number(),
    freeBytes: z.number(),
    usedPercent: z.number(),
    inodeUsedPercent: z.number().optional(),
  })
  .strict();

const metricsSchema = z
  .object({
    capturedAt: z.string().min(1),
    cpuPercent: z.number(),
    load1: z.number(),
    load5: z.number(),
    load15: z.number(),
    memoryTotalBytes: z.number(),
    memoryUsedBytes: z.number(),
    memoryAvailableBytes: z.number(),
    memoryUsedPercent: z.number(),
    swapTotalBytes: z.number().optional(),
    swapUsedBytes: z.number().optional(),
    disks: z.array(diskSchema).max(32),
    uptimeSeconds: z.number().optional(),
    processCount: z.number().optional(),
    agentVersion: z.string().max(64),
    leases: z.number().optional(),
    queueWaitMs: z.number().optional(),
  })
  .strict();

const heartbeatBodySchema = z
  .object({
    metrics: metricsSchema,
    status: z.enum(HOST_STATUSES).optional(),
    leases: z.number().int().min(0).optional(),
  })
  .strict();

const resultBodySchema = z
  .object({
    commandId: z.string().min(1).max(64),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.string().min(1).max(64),
        message: z.string().min(1).max(2000),
        details: z.unknown().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** 401 with the stable agent code; the console session cookie is irrelevant here. */
function agentUnauthorized(message: string): ApiError {
  return new ApiError('agent_unauthorized', 401, message);
}

/** Resolves the host from the bearer token; every command/heartbeat route starts here. */
async function requireAgent(c: Context): Promise<RunnerHostRecord> {
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) throw agentUnauthorized('missing agent bearer token');
  const host = await authenticateAgent(match[1] as string);
  if (!host) throw agentUnauthorized('invalid agent token');
  return host;
}

export function registerRunnerAgent(app: Hono, config: ApiConfig): void {
  /* ---------------------------------------------------------- preflight */

  app.post(`${API_PREFIX}/runner-enrollments/:token/preflight`, async (c) => {
    const token = c.req.param('token');
    const body = await readJsonBody<RunnerPreflightRequest>(c, preflightBodySchema);
    const stored = await recordPreflight(token, body);
    if (!stored) {
      throw new ApiError(
        'enrollment_invalid',
        404,
        'enrollment token is unknown, already used or expired',
      );
    }
    return c.json({ ok: true });
  });

  /* ------------------------------------------------------------- enroll */

  app.post(`${API_PREFIX}/runner-agent/enroll`, async (c) => {
    const body = await readJsonBody<RunnerEnrollmentRequest>(c, enrollBodySchema);
    try {
      const { hostId, agentToken } = await exchangeEnrollment({
        token: body.token,
        name: body.name,
        platform: body.platform,
        arch: body.arch,
        ...(body.pool ? { pool: body.pool } : {}),
        ...(body.labels ? { labels: body.labels } : {}),
        ...(body.maxConcurrent ? { maxConcurrent: body.maxConcurrent } : {}),
        ...(body.agentVersion ? { agentVersion: body.agentVersion } : {}),
        ...(body.hostname ? { hostname: body.hostname } : {}),
      });
      // The agent token is returned exactly once; only its hash is stored.
      return c.json(
        {
          hostId,
          agentToken,
          heartbeatIntervalMs: config.remoteHeartbeatIntervalMs,
          commandPollTimeoutMs: DEFAULT_COMMAND_POLL_TIMEOUT_MS,
        },
        201,
      );
    } catch (error) {
      if (error instanceof RunnerEnrollmentError) {
        throw new ApiError('enrollment_invalid', 400, error.message);
      }
      throw error;
    }
  });

  /* ---------------------------------------------------------- heartbeat */

  app.post(`${API_PREFIX}/runner-agent/heartbeat`, async (c) => {
    const host = await requireAgent(c);
    const body = await readJsonBody<RunnerHeartbeatRequest>(c, heartbeatBodySchema);
    await recordHeartbeat(host.id, {
      metrics: body.metrics as RunnerMetrics,
      ...(body.status ? { status: body.status } : {}),
      ...(body.leases !== undefined ? { leases: body.leases } : {}),
    });
    return c.json({ ok: true });
  });

  /* ----------------------------------------------------------- commands */

  app.get(`${API_PREFIX}/runner-agent/commands`, async (c) => {
    const host = await requireAgent(c);
    const requested = Number(c.req.query('waitMs') ?? DEFAULT_COMMAND_POLL_TIMEOUT_MS);
    const waitMs = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 0), 30_000)
      : DEFAULT_COMMAND_POLL_TIMEOUT_MS;
    const command = await claimCommand(host.id, waitMs);
    return c.json({ command });
  });

  app.post(`${API_PREFIX}/runner-agent/commands/:id/result`, async (c) => {
    const host = await requireAgent(c);
    const id = c.req.param('id');
    const body = await readJsonBody<RunnerCommandResultEnvelope>(c, resultBodySchema);
    if (body.commandId !== id) {
      throw invalidRequest('body `commandId` must match the path', {
        commandId: body.commandId,
        id,
      });
    }
    const completed = await completeCommand(
      id,
      {
        ok: body.ok,
        ...(body.result !== undefined ? { result: body.result } : {}),
        ...(body.error ? { error: body.error } : {}),
      },
      host.id,
    );
    if (!completed) {
      throw new ApiError('command_not_found', 404, `no open command "${id}" for this host`, { id });
    }
    return c.json({ ok: true });
  });
}
