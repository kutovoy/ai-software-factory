import { Hono } from 'hono';
import { z } from 'zod';
import {
  cancelRun,
  getRun,
  hasPermissionRequest,
  issueProxyToken,
  listEvents,
  pingDb,
  requestRunCancel,
  setPermissionDecision,
  submitPermissionDecision,
  temporalHealthy,
  type HarnessId,
} from '@factory/orchestration';
import {
  automationPauseBodySchema,
  pauseAutomationForApi,
  syncAutomationsForApi,
  type AutomationPauseBody,
} from './automations';
import {
  benchmarkGateStatus,
  benchmarkRunBodySchema,
  getBenchmarkRunForApi,
  getBenchmarkSuitesForApi,
  listAttestationsForApi,
  startBenchmarkForApi,
  type BenchmarkRunBody,
} from './benchmarks';
import type { ApiConfig } from './config';
import { toOrchestrationConfig } from './config';
import {
  ApiError,
  invalidRequest,
  permissionNotFound,
  runNotFound,
  toEnvelope,
  unsupportedCapability,
} from './errors';
import {
  getFactory,
  getFactoryDiff,
  getFactoryResources,
  getFactoryVersions,
  listFactories,
} from './factories';
import {
  authorityChangeBodySchema,
  canaryPruneBodySchema,
  canaryPromoteBodySchema,
  canaryRollbackBodySchema,
  canaryStartBodySchema,
  changeAuthorityForApi,
  decideProposalForApi,
  applyProposalForApi,
  getCanaryForApi,
  getImprovementForApi,
  getImprovementRunForApi,
  getProposalForApi,
  improvementRunBodySchema,
  listLessonsForApi,
  listProposalsForApi,
  pruneCanaryForApi,
  promoteCanaryForApi,
  promoteLessonBodySchema,
  promoteLessonForApi,
  proposalApplyBodySchema,
  proposalDecisionBodySchema,
  rollbackCanaryForApi,
  startCanaryForApi,
  startImprovementForApi,
  type AuthorityChangeBody,
  type CanaryPruneBody,
  type CanaryPromoteBody,
  type CanaryRollbackBody,
  type CanaryStartBody,
  type ImprovementRunBody,
  type PromoteLessonBody,
  type ProposalApplyBody,
  type ProposalDecisionBody,
} from './improvement';
import {
  configureGithubForApi,
  getIntegrationsForApi,
  githubIntegrationBodySchema,
  type GithubIntegrationBody,
} from './integrations';
import { log } from './logger';
import {
  getAutomationsForApi,
  getMergeQueueForApi,
  mergeRevertBodySchema,
  revertMergeBatchForApi,
  type MergeRevertBody,
} from './merge-queue';
import { registerProxy } from './proxy';
import {
  getMcpForApi,
  mcpSyncBodySchema,
  syncMcpForApi,
  testMcpForApi,
  type McpSyncBody,
} from './mcp';
import {
  assertSecretName,
  deleteSecretForApi,
  getSecretUsageForApi,
  listSecretsForApi,
  registerSecretBodySchema,
  registerSecretForApi,
  rotateSecretBodySchema,
  rotateSecretForApi,
  type RegisterSecretBody,
  type RotateSecretBody,
} from './secrets';
import {
  createRun,
  getRunDetail,
  listRuns,
  summarize,
  type CreateRunBody,
} from './runs';
import { createEventStream, parseLastEventId } from './sse';
import {
  calibrationBodySchema,
  getCalibrationForApi,
  getMetricsForApi,
  getScoreForApi,
  getScorersForApi,
  listScoresForApi,
  scoringBodySchema,
  startCalibrationForApi,
  startScoringForApi,
  type CalibrationBody,
  type ScoringBody,
} from './scoring';
import { registerWebhooks } from './webhooks';
import { getSql } from '@factory/orchestration';
import {
  autonomyBodySchema,
  cancelWorkItemBodySchema,
  cancelWorkItemForApi,
  createWorkItemBodySchema,
  createWorkItemForApi,
  getAutonomyForApi,
  gateDecisionBodySchema,
  getWorkItemDetail,
  listWorkItemsForApi,
  setAutonomyForApi,
  submitGateDecisionForApi,
  type AutonomyBody,
  type CancelWorkItemBody,
  type CreateWorkItemBody,
} from './work-items';
import { modelSchema, type GateDecisionRequest } from '@factory/core';

const TERMINAL = new Set(['ok', 'error', 'cancelled']);

/** Capability matrix mirrors `packages/adapters/README.md` — declared, never guessed. */
const PERMISSIONS: Record<HarnessId, 'interactive' | 'static' | 'none'> = {
  fake: 'interactive',
  opencode: 'interactive',
  'claude-code': 'static',
  codex: 'static',
  gemini: 'interactive',
  'generic-cli': 'none',
};

const harnessEnum = z.enum(['opencode', 'claude-code', 'codex', 'gemini', 'generic-cli', 'fake']);
const runnerEnum = z.enum(['local-docker', 'local-process', 'fake']);

const runBodySchema = z
  .object({
    factory: z.string().min(1),
    prompt: z.string().optional(),
    files: z.array(z.string()).optional(),
    harness: harnessEnum.optional(),
    model: modelSchema.optional(),
    agent: z.string().min(1).optional(),
    runner: runnerEnum.optional(),
    title: z.string().min(1).optional(),
    fakeDelayMs: z.number().int().min(0).max(60_000).optional(),
  })
  .strict();

const chatBodySchema = runBodySchema
  .extend({ factory: z.string().min(1).optional(), prompt: z.string().min(1) })
  .strict();

const permissionBodySchema = z.object({ decision: z.enum(['allow', 'deny', 'always']) }).strict();

async function json<T>(c: { req: { json: () => Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw invalidRequest('request body must be JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalidRequest('invalid request body', parsed.error.issues);
  return parsed.data;
}

/** A body is optional for actions that only re-register metadata (`rotate`). */
async function jsonOptional<T>(
  c: { req: { json: () => Promise<unknown> } },
  schema: z.ZodType<T>,
  fallback: T,
): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fallback;
  }
  if (body === null || body === undefined || body === '') return fallback;
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalidRequest('invalid request body', parsed.error.issues);
  return parsed.data;
}

export function createApp(config: ApiConfig): Hono {
  // Seed the shared SQL singleton with this process's DATABASE_URL.
  getSql(config.databaseUrl);

  const app = new Hono();
  const startedAt = Date.now();

  app.onError((error, c) => {
    const { status, body } = toEnvelope(error);
    if (status >= 500) {
      log('error', 'request_failed', {
        path: c.req.path,
        method: c.req.method,
        code: body.code,
        message: body.message,
      });
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });

  app.notFound((c) =>
    c.json({ code: 'not_found', message: `no route for ${c.req.method} ${c.req.path}` }, 404),
  );

  /* --------------------------------------------------------------- health */

  app.get('/health', async (c) => {
    const [db, temporal] = await Promise.all([
      pingDb(config.databaseUrl)
        .then(() => ({ ok: true as const }))
        .catch((error: unknown) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        })),
      temporalHealthy(toOrchestrationConfig(config)),
    ]);

    const ok = db.ok && temporal.ok;
    return c.json(
      {
        status: ok ? 'ok' : 'degraded',
        version: config.version,
        uptimeMs: Date.now() - startedAt,
        checks: { db, temporal },
      },
      ok ? 200 : 503,
    );
  });

  /* ------------------------------------------------------------ factories */

  app.get('/factories', (c) => c.json({ factories: listFactories(config) }));

  /* -------------------------------------------------------- secrets (6.1) */

  app.get('/secrets', async (c) => c.json(await listSecretsForApi(config)));

  app.post('/secrets', async (c) => {
    const body = await json<RegisterSecretBody>(c, registerSecretBodySchema);
    return c.json(await registerSecretForApi(config, body), 201);
  });

  app.delete('/secrets/:name', async (c) => {
    const name = c.req.param('name');
    assertSecretName(name);
    return c.json(await deleteSecretForApi(config, name));
  });

  app.post('/secrets/:name/rotate', async (c) => {
    const name = c.req.param('name');
    assertSecretName(name);
    const body = await jsonOptional<RotateSecretBody>(c, rotateSecretBodySchema, {});
    return c.json(await rotateSecretForApi(config, name, body));
  });

  app.get('/secrets/:name/usage', async (c) => {
    const name = c.req.param('name');
    assertSecretName(name);
    return c.json(await getSecretUsageForApi(config, name));
  });

  /* ---------------------------------------------------- MCP wiring (6.3) */

  app.get('/factories/:name/mcp', async (c) =>
    c.json(await getMcpForApi(config, c.req.param('name'))),
  );

  app.post('/factories/:name/mcp', async (c) => {
    const body = await jsonOptional<McpSyncBody>(c, mcpSyncBodySchema, {});
    return c.json(await syncMcpForApi(config, c.req.param('name'), body));
  });

  app.post('/factories/:name/mcp/:server/test', async (c) =>
    c.json(
      await testMcpForApi(config, c.req.param('name'), c.req.param('server')),
    ),
  );

  app.get('/factories/:name', (c) => c.json({ factory: getFactory(config, c.req.param('name')) }));

  app.get('/factories/:name/resources', (c) =>
    c.json(getFactoryResources(config, c.req.param('name'))),
  );

  app.get('/factories/:name/versions', (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    return c.json({
      factory: c.req.param('name'),
      versions: getFactoryVersions(
        config,
        c.req.param('name'),
        Number.isFinite(limit) ? limit : 20,
      ),
    });
  });

  app.get('/factories/:name/diff', (c) =>
    c.json(
      getFactoryDiff(
        config,
        c.req.param('name'),
        c.req.query('from') ?? undefined,
        c.req.query('to') ?? undefined,
      ),
    ),
  );

  /* -------------------------------------------------------------- scorers */

  app.get('/factories/:name/scorers', async (c) =>
    c.json(await getScorersForApi(config, c.req.param('name'))),
  );

  app.get('/factories/:name/metrics', async (c) =>
    c.json(await getMetricsForApi(config, c.req.param('name'), c.req.query('window') ?? null)),
  );

  /* --------------------------------------------------------------- scores */

  app.get('/scores', async (c) => {
    const limit = Number(c.req.query('limit') ?? '100');
    const offset = Number(c.req.query('offset') ?? '0');
    return c.json(
      await listScoresForApi({
        ...(c.req.query('factory') ? { factory: c.req.query('factory') as string } : {}),
        ...(c.req.query('run') ? { run: c.req.query('run') as string } : {}),
        ...(c.req.query('workItem') ? { workItem: c.req.query('workItem') as string } : {}),
        ...(c.req.query('stage') ? { stage: c.req.query('stage') as string } : {}),
        ...(c.req.query('scorer') ? { scorer: c.req.query('scorer') as string } : {}),
        ...(c.req.query('window') ? { window: c.req.query('window') as string } : {}),
        limit: Number.isFinite(limit) ? limit : 100,
        offset: Number.isFinite(offset) ? offset : 0,
      }),
    );
  });

  app.get('/scores/:id', async (c) => c.json(await getScoreForApi(c.req.param('id'))));

  /* ---------------------------------------------------------- calibration */

  app.post('/calibration', async (c) => {
    const body = await json<CalibrationBody>(c, calibrationBodySchema);
    return c.json(await startCalibrationForApi(config, body), 201);
  });

  app.get('/calibration/:scorer', async (c) =>
    c.json(
      await getCalibrationForApi(
        config,
        c.req.query('factory') ?? config.defaultFactory,
        c.req.param('scorer'),
      ),
    ),
  );

  /* -------------------------------------------------------------- scoring */

  app.post('/scoring', async (c) => {
    const body = await json<ScoringBody>(c, scoringBodySchema);
    return c.json(await startScoringForApi(config, body), 202);
  });

  /* ------------------------------------------------------------ benchmarks */

  app.get('/factories/:name/benchmarks', async (c) =>
    c.json(await getBenchmarkSuitesForApi(config, c.req.param('name'))),
  );

  app.post('/factories/:name/benchmarks/:suite/run', async (c) => {
    const body = await json<BenchmarkRunBody>(c, benchmarkRunBodySchema);
    const result = await startBenchmarkForApi(
      config,
      c.req.param('name'),
      c.req.param('suite'),
      body,
    );
    // A dry run is an estimate, not a resource creation.
    return c.json(result, 'workflow' in result ? 202 : 200);
  });

  app.get('/benchmarks/:id', async (c) => c.json(await getBenchmarkRunForApi(c.req.param('id'))));

  app.get('/factories/:name/attestations', async (c) =>
    c.json(await listAttestationsForApi(config, c.req.param('name'))),
  );

  app.get('/factories/:name/benchmark-gate', async (c) =>
    c.json(await benchmarkGateStatus(config, c.req.param('name'))),
  );

  /* ------------------------------------------------------ self-improvement */

  app.get('/factories/:name/improvement', async (c) =>
    c.json(await getImprovementForApi(config, c.req.param('name'))),
  );

  app.get('/factories/:name/canary', async (c) =>
    c.json(await getCanaryForApi(config, c.req.param('name'))),
  );

  app.post('/factories/:name/canary', async (c) => {
    const body = await json<CanaryStartBody>(c, canaryStartBodySchema);
    return c.json(await startCanaryForApi(config, c.req.param('name'), body), 202);
  });

  app.post('/factories/:name/improvement/run', async (c) => {
    const body = await json<ImprovementRunBody>(c, improvementRunBodySchema);
    return c.json(await startImprovementForApi(config, c.req.param('name'), body), 202);
  });

  app.post('/factories/:name/improvement/authority', async (c) => {
    const body = await json<AuthorityChangeBody>(c, authorityChangeBodySchema);
    return c.json(await changeAuthorityForApi(config, c.req.param('name'), body));
  });

  app.get('/improvements/:id', async (c) => c.json(await getImprovementRunForApi(c.req.param('id'))));

  app.get('/proposals', async (c) => {
    const limit = Number(c.req.query('limit') ?? '50');
    return c.json({
      proposals: await listProposalsForApi({
        ...(c.req.query('factory') ? { factory: c.req.query('factory') as string } : {}),
        ...(c.req.query('status') ? { status: c.req.query('status') as never } : {}),
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    });
  });

  app.get('/proposals/:id', async (c) => c.json(await getProposalForApi(c.req.param('id'))));

  app.post('/proposals/:id/decision', async (c) => {
    const body = await json<ProposalDecisionBody>(c, proposalDecisionBodySchema);
    return c.json(await decideProposalForApi(config, c.req.param('id'), body));
  });

  app.post('/proposals/:id/apply', async (c) => {
    const body = await json<ProposalApplyBody>(c, proposalApplyBodySchema);
    return c.json(await applyProposalForApi(config, c.req.param('id'), body));
  });

  app.get('/lessons', async (c) => {
    const limit = Number(c.req.query('limit') ?? '100');
    return c.json(
      await listLessonsForApi(config, {
        ...(c.req.query('factory') ? { factory: c.req.query('factory') as string } : {}),
        ...(c.req.query('includeShared') !== undefined
          ? { includeShared: c.req.query('includeShared') === 'true' }
          : {}),
        limit: Number.isFinite(limit) ? limit : 100,
      }),
    );
  });

  app.post('/lessons/:id/promote', async (c) => {
    const body = await json<PromoteLessonBody>(c, promoteLessonBodySchema);
    return c.json({ lesson: await promoteLessonForApi(c.req.param('id'), body) });
  });

  app.post('/canary/rollback', async (c) => {
    const body = await json<CanaryRollbackBody>(c, canaryRollbackBodySchema);
    return c.json(await rollbackCanaryForApi(config, body));
  });

  app.post('/canary/promote', async (c) => {
    const body = await json<CanaryPromoteBody>(c, canaryPromoteBodySchema);
    return c.json(await promoteCanaryForApi(config, body));
  });

  app.post('/factories/:name/canary/prune', async (c) => {
    const body = await json<CanaryPruneBody>(c, canaryPruneBodySchema);
    return c.json(await pruneCanaryForApi(config, c.req.param('name'), body));
  });

  /* ------------------------------------------------------- integrations */
  app.get('/factories/:name/integrations', async (c) =>
    c.json(await getIntegrationsForApi(config, c.req.param('name'))),
  );

  app.post('/integrations/github', async (c) => {
    const body = await json<GithubIntegrationBody>(c, githubIntegrationBodySchema);
    return c.json(await configureGithubForApi(config, body));
  });

  /* --------------------------------------------------------- merge queue */
  app.get('/factories/:name/merge-queue', async (c) =>
    c.json(await getMergeQueueForApi(config, c.req.param('name'))),
  );

  app.post('/merge-queue/revert', async (c) => {
    const body = await json<MergeRevertBody>(c, mergeRevertBodySchema);
    return c.json(await revertMergeBatchForApi(config, body), 202);
  });

  /* --------------------------------------------------------- automations */
  app.get('/factories/:name/automations', async (c) =>
    c.json(await getAutomationsForApi(config, c.req.param('name'))),
  );

  app.post('/factories/:name/automations/sync', async (c) =>
    c.json(await syncAutomationsForApi(config, c.req.param('name'))),
  );

  app.post('/factories/:name/automations/:automation/pause', async (c) => {
    const body = await json<AutomationPauseBody>(c, automationPauseBodySchema);
    return c.json(
      await pauseAutomationForApi(config, c.req.param('name'), c.req.param('automation'), body),
    );
  });

  /* ----------------------------------------------------------------- runs */

  app.post('/runs', async (c) => {
    const body = await json<CreateRunBody>(c, runBodySchema);
    const created = await createRun(config, body, { kind: 'run' });
    return c.json(
      {
        run: summarize(created.run),
        workflow: created.workflow,
        proxy: created.proxy,
      },
      201,
    );
  });

  app.get('/runs', async (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    const offset = Number(c.req.query('offset') ?? '0');
    const runs = await listRuns({
      limit: Number.isFinite(limit) ? limit : 20,
      offset: Number.isFinite(offset) ? offset : 0,
      status: c.req.query('status') ?? undefined,
      factory: c.req.query('factory') ?? undefined,
    });
    return c.json({ runs });
  });

  app.get('/runs/:id', async (c) => {
    const detail = await getRunDetail(c.req.param('id'));
    return c.json(detail);
  });

  /* ---------------------------------------------------------------- events */

  app.get('/runs/:id/events', async (c) => {
    const runId = c.req.param('id');
    const run = await getRun(runId);
    if (!run) throw runNotFound(runId);

    const lastEventId = parseLastEventId(
      c.req.header('Last-Event-ID') ?? c.req.query('lastEventId') ?? null,
    );

    const stream = createEventStream({
      lastEventId,
      fetchPage: async (afterSeq) => {
        const rows = await listEvents(runId, afterSeq);
        return rows.map((row) => ({
          seq: Number(row.seq),
          type: row.type,
          payload: row.payload,
        }));
      },
      isTerminal: async () => {
        const current = await getRun(runId);
        return Boolean(current && TERMINAL.has(current.status));
      },
      maxLifetimeMs: config.sseMaxLifetimeMs,
      signal: c.req.raw.signal,
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  });

  /* ---------------------------------------------------------------- cancel */

  app.post('/runs/:id/cancel', async (c) => {
    const runId = c.req.param('id');
    const run = await getRun(runId);
    if (!run) throw runNotFound(runId);

    if (TERMINAL.has(run.status)) {
      return c.json({ runId, status: run.status, cancelled: false, alreadyTerminal: true });
    }

    let reason: string | undefined;
    try {
      const body = (await c.req.json()) as { reason?: string } | undefined;
      reason = body?.reason;
    } catch {
      // cancellation without a body is fine
    }

    await requestRunCancel(runId, reason ?? 'cancelled');
    await cancelRun(runId, reason ?? 'cancelled', toOrchestrationConfig(config));

    log('info', 'run_cancel_requested', { runId });
    return c.json({ runId, status: 'cancelling', cancelled: true }, 202);
  });

  /* ----------------------------------------------------------- permissions */

  app.post('/runs/:id/permissions/:requestId', async (c) => {
    const runId = c.req.param('id');
    const requestId = c.req.param('requestId');
    const run = await getRun(runId);
    if (!run) throw runNotFound(runId);

    const mode = PERMISSIONS[run.harness as HarnessId] ?? 'none';
    if (mode !== 'interactive') {
      throw unsupportedCapability(
        `harness "${run.harness}" does not support interactive permissions (mode: ${mode})`,
        { runId, harness: run.harness, permissions: mode },
      );
    }

    const body = await json<{ decision: 'allow' | 'deny' | 'always' }>(c, permissionBodySchema);
    if (!(await hasPermissionRequest(runId, requestId))) {
      throw permissionNotFound(runId, requestId);
    }

    const updated = await setPermissionDecision({ runId, requestId, decision: body.decision });
    if (!updated) throw permissionNotFound(runId, requestId);

    // The read model records the decision (UI/inbox), then the workflow receives it as a
    // Temporal Update (Signal fallback) — ADR-013: permission waits are workflow-level
    // durable waits, not activity-blocking polls. The response shape is unchanged.
    let delivery: 'update' | 'signal' | 'failed' = 'failed';
    try {
      const result = await submitPermissionDecision(
        { runId, requestId, decision: body.decision },
        toOrchestrationConfig(config),
      );
      delivery = result.delivered;
    } catch (error) {
      log('error', 'permission_delivery_failed', {
        runId,
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    log('info', 'permission_decided', { runId, requestId, decision: body.decision, delivery });
    return c.json({ runId, requestId, decision: body.decision });
  });

  /* ----------------------------------------------------------- work items */

  app.post('/work-items', async (c) => {
    const body = await json<CreateWorkItemBody>(c, createWorkItemBodySchema);
    const created = await createWorkItemForApi(config, body);
    return c.json(created, 201);
  });

  app.get('/work-items', async (c) => {
    const limit = Number(c.req.query('limit') ?? '50');
    const offset = Number(c.req.query('offset') ?? '0');
    const workItems = await listWorkItemsForApi({
      ...(c.req.query('factory') ? { factory: c.req.query('factory') as string } : {}),
      ...(c.req.query('stage') ? { stage: c.req.query('stage') as string } : {}),
      ...(c.req.query('status') ? { status: c.req.query('status') as string } : {}),
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return c.json({ workItems });
  });

  app.get('/work-items/:id', async (c) => c.json(await getWorkItemDetail(c.req.param('id'))));

  app.post('/work-items/:id/cancel', async (c) => {
    const body = await json<CancelWorkItemBody>(c, cancelWorkItemBodySchema);
    return c.json(await cancelWorkItemForApi(config, c.req.param('id'), body));
  });

  app.post('/work-items/:id/gates/:stage', async (c) => {
    const body = await json<GateDecisionRequest>(c, gateDecisionBodySchema);
    const result = await submitGateDecisionForApi(
      config,
      c.req.param('id'),
      c.req.param('stage'),
      body,
    );
    return c.json(result);
  });

  /* ------------------------------------------------------------- autonomy */

  app.get('/autonomy', async (c) =>
    c.json({
      autonomy: await getAutonomyForApi(config, c.req.query('factory') ?? config.defaultFactory),
    }),
  );

  app.post('/autonomy', async (c) => {
    const body = await json<AutonomyBody>(c, autonomyBodySchema);
    return c.json({ autonomy: await setAutonomyForApi(config, body) });
  });

  /* ------------------------------------------------------------------ chat */

  app.post('/chat', async (c) => {
    const body = await json<Omit<CreateRunBody, 'factory'> & { factory?: string }>(
      c,
      chatBodySchema,
    );
    const created = await createRun(
      config,
      { ...body, factory: body.factory ?? config.defaultFactory },
      { kind: 'chat' },
    );
    return c.json(
      {
        run: summarize(created.run),
        workflow: created.workflow,
        proxy: created.proxy,
      },
      201,
    );
  });

  /* -------------------------------------------------- dev-only proxy token */

  if (config.exposeRunToken) {
    app.post('/runs/:id/proxy-token', async (c) => {
      const runId = c.req.param('id');
      const run = await getRun(runId);
      if (!run) throw runNotFound(runId);
      if (TERMINAL.has(run.status)) {
        throw new ApiError('token_revoked', 409, 'the run is no longer active', { runId });
      }
      const models = Array.isArray(run.input && (run.input as { proxyModels?: string[] }).proxyModels)
        ? ((run.input as { proxyModels?: string[] }).proxyModels ?? [])
        : [];
      const minted = await issueProxyToken({ runId, models });
      if (!minted) throw new ApiError('no_models', 409, 'this run has no model allowlist', { runId });
      // Returned once, dev/smoke only; never logged.
      return c.json({ runId, token: minted.token, tokenId: minted.tokenId, baseUrl: config.proxyPublicUrl, models });
    });
  }

  registerProxy(app, config);
  registerWebhooks(app, config);

  return app;
}
