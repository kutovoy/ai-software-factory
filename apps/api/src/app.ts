import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Hono, type Context, type Handler } from 'hono';
import { z } from 'zod';
import {
  artifactStoreFromConfig,
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
  type RunArtifact,
} from '@factory/orchestration';
import {
  automationPauseBodySchema,
  pauseAutomationForApi,
  syncAutomationsForApi,
  type AutomationPauseBody,
} from './automations';
import {
  authMiddleware,
  ownerFilter,
  registerAuth,
  sessionUserId,
  viewerOf,
  type AuthVariables,
} from './auth';
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
  loadFactoryDefinition,
  resolveFactory,
  resolveFactoryDir,
} from './factories';
import { getInboxForApi } from './inbox';
import { decodeCursor } from './cursor';
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
import { registerRunnerAgent } from './runner-agent';
import { registerRunners } from './runners';
import { purgeFactoryForApi } from './purge';
import { getReadinessForApi } from './readiness';
import { getGuardHooksForApi } from './guard';
import { API_PREFIX, isPublicRoute, openApiPath, type RouteEntry } from './routes';
import {
  getMcpForApi,
  mcpSyncBodySchema,
  syncMcpForApi,
  testMcpForApi,
  type McpSyncBody,
} from './mcp';
import {
  discoverBodySchema,
  discoverCapabilitiesForApi,
  getCapabilitiesForApi,
  promoteCapabilityForApi,
  type DiscoverBody,
} from './capabilities';
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
  assertRunAccess,
  createRun,
  factorySpendUsd,
  retryRun,
  getRunDetail,
  listRuns,
  summarize,
  type CreateRunBody,
} from './runs';
import {
  contentDispositionForArtifact,
  planArtifactDownload,
} from './artifacts';
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
import { registerIntake } from './intake';
import { getGovernanceForApi } from './governance';
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
  listWorkItemBoardForApi,
  listWorkItemsForApi,
  retryWorkItemBodySchema,
  retryWorkItemForApi,
  setAutonomyForApi,
  submitGateDecisionForApi,
  type AutonomyBody,
  type CancelWorkItemBody,
  type CreateWorkItemBody,
  type RetryWorkItemBody,
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
const runnerEnum = z.enum(['local-docker', 'local-process', 'remote', 'fake']);

const runBodySchema = z
  .object({
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
  .extend({ prompt: z.string().min(1) })
  .strict();

const permissionBodySchema = z.object({ decision: z.enum(['allow', 'deny', 'always']) }).strict();

/** `DELETE /factories/:factoryId` accepts `force`/`dryRun` in the query string or the body. */
const purgeBodySchema = z
  .object({ force: z.boolean().optional(), dryRun: z.boolean().optional() })
  .strict();

function flag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

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

let openApiCache: unknown = null;

/**
 * Serves the OpenAPI 3.1 document checked into `apps/api/openapi.json`. It is the source of
 * truth for the public surface; `test/openapi.test.ts` fails when it diverges from the
 * registered routes (ADR-030).
 */
function loadOpenApiDocument(): unknown {
  openApiCache ??= JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
  return openApiCache;
}

export function createApp(config: ApiConfig): Hono {
  // Seed the shared SQL singleton with this process's DATABASE_URL.
  getSql(config.databaseUrl);

  const app = new Hono();
  /** Versioned resource surface: mounted under `API_PREFIX` at the end of this function. */
  const api = new Hono<{ Variables: AuthVariables }>();
  const startedAt = Date.now();

  // Auth runs before every versioned route (change `add-console-auth`): it resolves the
  // session cookie, attaches `user` to the context and enforces `AUTH_REQUIRED`. Registering
  // it here — not per route — is what makes "a route cannot forget it" true.
  api.use('*', authMiddleware(config));

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

  const health: Handler = async (c) => {
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
  };

  // Unversioned for probes (compose healthcheck, ADR-030) …
  app.get('/health', health);
  // … and available to versioned clients under the prefix.
  api.get('/health', health);

  /* ---------------------------------------------------------------- openapi */

  api.get('/openapi.json', (c) => c.json(loadOpenApiDocument() as Record<string, unknown>));

  /* ---------------------------------------------------------------- auth */

  registerAuth(api, config);

  /* ------------------------------------------------------------ factories */

  api.get('/factories', async (c) =>
    c.json({ factories: await listFactories(config, viewerOf(config, c.get('user'))) }),
  );

  /**
   * Batch inbox projection (performance plan, Phase 2): pending gates, pending permissions
   * and failed runs in one response, owner-scoped in SQL. Replaces the per-factory list +
   * per-item detail fan-out the console used to perform.
   */
  api.get('/inbox', async (c) => {
    const limit = Number(c.req.query('limit') ?? '50');
    return c.json(
      await getInboxForApi(viewerOf(config, c.get('user')), {
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    );
  });

  /**
   * Every factory-scoped route resolves the factory **by its opaque id** before doing
   * anything else (change `add-factory-identity`, spec `factory-identity`). A member only
   * resolves factories they own; a missing or foreign id is `404 factory_not_found`, never
   * `403`, so existence is not leaked. The internal key (`name` or `owner/name`) is what the
   * existing projections and tables take.
   */
  const factoryOf = (c: Context<{ Variables: AuthVariables }>) =>
    resolveFactory(config, c.req.param('factoryId') ?? '', viewerOf(config, c.get('user')));

  api.get('/factories/:factoryId', async (c) => {
    const record = await factoryOf(c);
    return c.json({ factory: getFactory(config, record.key, record.version) });
  });

  /**
   * Purge (change `fix-factory-purge`, spec `factory-purge`): remove every factory-scoped
   * row, schedule, running workflow and `runs/<id>/` directory. `factoryOf` already applies
   * owner/admin scope, so a foreign or unknown id is `404`. Active work requires `force`;
   * a missing database/Temporal aborts with `503` before anything is deleted. Git history
   * and forge repositories/PRs are kept.
   */
  api.delete('/factories/:factoryId', async (c) => {
    const record = await factoryOf(c);
    const body = await jsonOptional(c, purgeBodySchema, {});
    return c.json(
      await purgeFactoryForApi(config, record, {
        force: flag(c.req.query('force')) || body.force === true,
        dryRun: flag(c.req.query('dryRun')) || body.dryRun === true,
      }),
    );
  });

  api.get('/factories/:factoryId/resources', async (c) =>
    c.json(getFactoryResources(config, (await factoryOf(c)).key)),
  );

  api.get('/factories/:factoryId/versions', async (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    const key = (await factoryOf(c)).key;
    return c.json({
      factory: key,
      versions: getFactoryVersions(config, key, Number.isFinite(limit) ? limit : 20),
    });
  });

  api.get('/factories/:factoryId/diff', async (c) =>
    c.json(
      getFactoryDiff(
        config,
        (await factoryOf(c)).key,
        c.req.query('from') ?? undefined,
        c.req.query('to') ?? undefined,
      ),
    ),
  );

  /* ------------------------------------------ agent readiness / guard hooks */

  api.get('/factories/:factoryId/readiness', async (c) =>
    c.json(await getReadinessForApi(config, (await factoryOf(c)).key)),
  );

  api.get('/factories/:factoryId/guard-hooks', async (c) =>
    c.json(await getGuardHooksForApi(config, (await factoryOf(c)).key)),
  );

  /* -------------------------------------------------------- secrets (6.1) */

  api.get('/secrets', async (c) => c.json(await listSecretsForApi(config)));

  api.post('/secrets', async (c) => {
    const body = await json<RegisterSecretBody>(c, registerSecretBodySchema);
    return c.json(await registerSecretForApi(config, body), 201);
  });

  api.delete('/secrets/:name', async (c) => {
    const name = c.req.param('name');
    assertSecretName(name);
    return c.json(await deleteSecretForApi(config, name));
  });

  api.post('/secrets/:name/rotate', async (c) => {
    const name = c.req.param('name');
    assertSecretName(name);
    const body = await jsonOptional<RotateSecretBody>(c, rotateSecretBodySchema, {});
    return c.json(await rotateSecretForApi(config, name, body));
  });

  api.get('/secrets/:name/usage', async (c) => {
    const name = c.req.param('name');
    assertSecretName(name);
    return c.json(await getSecretUsageForApi(config, name));
  });

  /* ---------------------------------------------------- MCP wiring (6.3) */

  api.get('/factories/:factoryId/mcp', async (c) =>
    c.json(await getMcpForApi(config, (await factoryOf(c)).key)),
  );

  api.post('/factories/:factoryId/mcp', async (c) => {
    const body = await jsonOptional<McpSyncBody>(c, mcpSyncBodySchema, {});
    return c.json(await syncMcpForApi(config, (await factoryOf(c)).key, body));
  });

  api.post('/factories/:factoryId/mcp/:server/test', async (c) => {
    const key = (await factoryOf(c)).key;
    return c.json(await testMcpForApi(config, key, c.req.param('server')));
  });

  /* ------------------------------------------- progressive context (item 9) */

  api.get('/factories/:factoryId/capabilities', async (c) =>
    c.json(
      await getCapabilitiesForApi(
        config,
        (await factoryOf(c)).key,
        c.req.query('q') ?? null,
      ),
    ),
  );

  api.get('/factories/:factoryId/capabilities/stats', async (c) => {
    const view = await getCapabilitiesForApi(
      config,
      (await factoryOf(c)).key,
      c.req.query('q') ?? '',
    );
    return c.json({
      factory: view.factory,
      declaredServers: view.declaredServers,
      fullSchemaBytes: view.selection?.fullSchemaBytes ?? 0,
      selectedSchemaBytes: view.selection?.selectedSchemaBytes ?? 0,
      savingsRatio: view.selection?.savingsRatio ?? 0,
      selected: view.selection?.entries ?? [],
      reason: view.selection?.reason ?? null,
    });
  });

  api.post('/factories/:factoryId/capabilities/discover', async (c) => {
    const body = await json<DiscoverBody>(c, discoverBodySchema);
    return c.json(await discoverCapabilitiesForApi(config, (await factoryOf(c)).key, body), 201);
  });

  api.post('/factories/:factoryId/capabilities/:server/:tool/promote', async (c) =>
    c.json(
      await promoteCapabilityForApi(
        config,
        (await factoryOf(c)).key,
        c.req.param('server'),
        c.req.param('tool'),
      ),
    ),
  );

  /* -------------------------------------------------------------- scorers */

  api.get('/factories/:factoryId/scorers', async (c) =>
    c.json(await getScorersForApi(config, (await factoryOf(c)).key)),
  );

  api.get('/factories/:factoryId/metrics', async (c) =>
    c.json(
      await getMetricsForApi(
        config,
        (await factoryOf(c)).key,
        c.req.query('window') ?? null,
      ),
    ),
  );

  /**
   * Spend caps + current spend (roadmap item 7). The per-run/stage caps are enforced in the
   * runner pump; the factory cap refuses new work at creation.
   */
  api.get('/factories/:factoryId/budget', async (c) => {
    const record = await factoryOf(c);
    const definition = loadFactoryDefinition(resolveFactoryDir(config, record.key), record.key);
    const budget = definition.manifest.budget ?? {};
    const spentUsd = await factorySpendUsd(record.key);
    const cap = budget.maxCostUsdPerFactory;
    return c.json({
      budget: {
        ...budget,
        spentUsd,
        exhausted: cap !== undefined && spentUsd >= cap,
      },
    });
  });

  /* --------------------------------------------------------------- scores */

  api.get('/factories/:factoryId/scores', async (c) => {
    const factory = (await factoryOf(c)).key;
    const limit = Number(c.req.query('limit') ?? '100');
    const offset = Number(c.req.query('offset') ?? '0');
    return c.json(
      await listScoresForApi({
        factory,
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

  api.get('/factories/:factoryId/scores/:id', async (c) =>
    c.json(await getScoreForApi((await factoryOf(c)).key, c.req.param('id'))),
  );

  /* ---------------------------------------------------------- calibration */

  api.post('/factories/:factoryId/calibration', async (c) => {
    const body = await json<CalibrationBody>(c, calibrationBodySchema);
    return c.json(await startCalibrationForApi(config, (await factoryOf(c)).key, body), 201);
  });

  api.get('/factories/:factoryId/calibration/:scorer', async (c) =>
    c.json(
      await getCalibrationForApi(
        config,
        (await factoryOf(c)).key,
        c.req.param('scorer'),
      ),
    ),
  );

  /* -------------------------------------------------------------- scoring */

  api.post('/factories/:factoryId/scoring', async (c) => {
    const body = await json<ScoringBody>(c, scoringBodySchema);
    return c.json(await startScoringForApi(config, (await factoryOf(c)).key, body), 202);
  });

  /* ------------------------------------------------------------ benchmarks */

  api.get('/factories/:factoryId/benchmarks', async (c) =>
    c.json(await getBenchmarkSuitesForApi(config, (await factoryOf(c)).key)),
  );

  api.post('/factories/:factoryId/benchmarks/:suite/run', async (c) => {
    const body = await json<BenchmarkRunBody>(c, benchmarkRunBodySchema);
    const result = await startBenchmarkForApi(
      config,
      (await factoryOf(c)).key,
      c.req.param('suite'),
      body,
    );
    // A dry run is an estimate, not a resource creation.
    return c.json(result, 'workflow' in result ? 202 : 200);
  });

  api.get('/factories/:factoryId/benchmarks/:id', async (c) =>
    c.json(await getBenchmarkRunForApi((await factoryOf(c)).key, c.req.param('id'))),
  );

  api.get('/factories/:factoryId/attestations', async (c) =>
    c.json(await listAttestationsForApi(config, (await factoryOf(c)).key)),
  );

  api.get('/factories/:factoryId/benchmark-gate', async (c) =>
    c.json(await benchmarkGateStatus(config, (await factoryOf(c)).key)),
  );

  /* ------------------------------------------------------ self-improvement */

  api.get('/factories/:factoryId/improvement', async (c) =>
    c.json(await getImprovementForApi(config, (await factoryOf(c)).key)),
  );

  api.post('/factories/:factoryId/improvement/run', async (c) => {
    const body = await json<ImprovementRunBody>(c, improvementRunBodySchema);
    return c.json(await startImprovementForApi(config, (await factoryOf(c)).key, body), 202);
  });

  api.post('/factories/:factoryId/improvement/authority', async (c) => {
    const body = await json<AuthorityChangeBody>(c, authorityChangeBodySchema);
    return c.json(await changeAuthorityForApi(config, (await factoryOf(c)).key, body));
  });

  api.get('/factories/:factoryId/improvements/:id', async (c) =>
    c.json(await getImprovementRunForApi((await factoryOf(c)).key, c.req.param('id'))),
  );

  api.get('/factories/:factoryId/proposals', async (c) => {
    const factory = (await factoryOf(c)).key;
    const limit = Number(c.req.query('limit') ?? '50');
    return c.json({
      proposals: await listProposalsForApi({
        factory,
        ...(c.req.query('status') ? { status: c.req.query('status') as never } : {}),
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    });
  });

  api.get('/factories/:factoryId/proposals/:id', async (c) =>
    c.json(await getProposalForApi((await factoryOf(c)).key, c.req.param('id'))),
  );

  api.post('/factories/:factoryId/proposals/:id/decision', async (c) => {
    const body = await json<ProposalDecisionBody>(c, proposalDecisionBodySchema);
    return c.json(
      await decideProposalForApi(config, (await factoryOf(c)).key, c.req.param('id'), body),
    );
  });

  api.post('/factories/:factoryId/proposals/:id/apply', async (c) => {
    const body = await json<ProposalApplyBody>(c, proposalApplyBodySchema);
    return c.json(
      await applyProposalForApi(config, (await factoryOf(c)).key, c.req.param('id'), body),
    );
  });

  api.get('/factories/:factoryId/lessons', async (c) => {
    const factory = (await factoryOf(c)).key;
    const limit = Number(c.req.query('limit') ?? '100');
    return c.json(
      await listLessonsForApi(config, {
        factory,
        ...(c.req.query('includeShared') !== undefined
          ? { includeShared: c.req.query('includeShared') === 'true' }
          : {}),
        limit: Number.isFinite(limit) ? limit : 100,
      }),
    );
  });

  api.post('/factories/:factoryId/lessons/:id/promote', async (c) => {
    const body = await json<PromoteLessonBody>(c, promoteLessonBodySchema);
    return c.json({
      lesson: await promoteLessonForApi((await factoryOf(c)).key, c.req.param('id'), body),
    });
  });

  /* -------------------------------------------------------------- canary */

  api.get('/factories/:factoryId/canary', async (c) =>
    c.json(await getCanaryForApi(config, (await factoryOf(c)).key)),
  );

  api.post('/factories/:factoryId/canary', async (c) => {
    const body = await json<CanaryStartBody>(c, canaryStartBodySchema);
    return c.json(await startCanaryForApi(config, (await factoryOf(c)).key, body), 202);
  });

  api.post('/factories/:factoryId/canary/prune', async (c) => {
    const body = await json<CanaryPruneBody>(c, canaryPruneBodySchema);
    return c.json(await pruneCanaryForApi(config, (await factoryOf(c)).key, body));
  });

  api.post('/factories/:factoryId/canary/promote', async (c) => {
    const body = await json<CanaryPromoteBody>(c, canaryPromoteBodySchema);
    return c.json(await promoteCanaryForApi(config, (await factoryOf(c)).key, body));
  });

  api.post('/factories/:factoryId/canary/rollback', async (c) => {
    const body = await json<CanaryRollbackBody>(c, canaryRollbackBodySchema);
    return c.json(await rollbackCanaryForApi(config, (await factoryOf(c)).key, body));
  });

  /* ------------------------------------------------------- integrations */
  api.get('/factories/:factoryId/integrations', async (c) =>
    c.json(await getIntegrationsForApi(config, (await factoryOf(c)).key)),
  );

  api.post('/factories/:factoryId/integrations/github', async (c) => {
    const body = await json<GithubIntegrationBody>(c, githubIntegrationBodySchema);
    return c.json(await configureGithubForApi(config, (await factoryOf(c)).key, body));
  });

  /* --------------------------------------------------------- merge queue */
  api.get('/factories/:factoryId/merge-queue', async (c) =>
    c.json(await getMergeQueueForApi(config, (await factoryOf(c)).key)),
  );

  api.post('/factories/:factoryId/merge-queue/revert', async (c) => {
    const body = await json<MergeRevertBody>(c, mergeRevertBodySchema);
    return c.json(await revertMergeBatchForApi(config, (await factoryOf(c)).key, body), 202);
  });

  /* --------------------------------------------------------- automations */
  api.get('/factories/:factoryId/automations', async (c) =>
    c.json(await getAutomationsForApi(config, (await factoryOf(c)).key)),
  );

  api.post('/factories/:factoryId/automations/sync', async (c) =>
    c.json(await syncAutomationsForApi(config, (await factoryOf(c)).key)),
  );

  api.post('/factories/:factoryId/automations/:automation/pause', async (c) => {
    const body = await json<AutomationPauseBody>(c, automationPauseBodySchema);
    return c.json(
      await pauseAutomationForApi(
        config,
        (await factoryOf(c)).key,
        c.req.param('automation'),
        body,
      ),
    );
  });

  /* ----------------------------------------------------------------- runs */

  api.post('/factories/:factoryId/runs', async (c) => {
    const body = await json<Omit<CreateRunBody, 'factory'>>(c, runBodySchema);
    const record = await factoryOf(c);
    const created = await createRun(
      config,
      { ...body, factory: record.key },
      { kind: 'run', factoryId: record.id },
      sessionUserId(config, c.get('user')),
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

  api.get('/factories/:factoryId/runs', async (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    const offset = Number(c.req.query('offset') ?? '0');
    const record = await factoryOf(c);
    const runs = await listRuns({
      limit: Number.isFinite(limit) ? limit : 20,
      offset: Number.isFinite(offset) ? offset : 0,
      status: c.req.query('status') ?? undefined,
      factory: record.key,
      createdBy: ownerFilter(viewerOf(config, c.get('user'))),
    });
    return c.json({ runs });
  });

  api.get('/factories/:factoryId/runs/:id', async (c) => {
    const record = await factoryOf(c);
    const detail = await getRunDetail(
      c.req.param('id'),
      viewerOf(config, c.get('user')),
      record.id,
    );
    return c.json(detail);
  });

  /* ---------------------------------------------------------------- events */

  /**
   * Artifact download (spec `artifact-store` › Download). Authorized by the normal run-access
   * guard; a stored blob redirects to a short-lived presigned GET, a local artifact streams
   * from `runs/<runId>/<path>` with traversal protection.
   */
  api.get('/factories/:factoryId/runs/:id/artifacts', async (c) => {
    const runId = c.req.param('id');
    const record = await factoryOf(c);
    const run = await assertRunAccess(runId, viewerOf(config, c.get('user')), record.id);

    const artifactPath = c.req.query('path');
    if (!artifactPath) throw invalidRequest('query `path` is required', { runId });

    const artifacts = Array.isArray(run.artifacts) ? (run.artifacts as RunArtifact[]) : [];
    const artifact = artifacts.find((entry) => entry && entry.path === artifactPath);
    if (!artifact) {
      throw new ApiError(
        'artifact_not_found',
        404,
        `run ${runId} has no artifact "${artifactPath}"`,
        { runId, path: artifactPath },
      );
    }

    const store = artifact.storageKey ? artifactStoreFromConfig(config.artifactStore) : null;
    if (artifact.storageKey && !store) {
      throw new ApiError(
        'artifact_store_unavailable',
        409,
        'artifact storage is not configured; this blob cannot be downloaded',
        { runId, path: artifactPath },
      );
    }

    const plan = planArtifactDownload({
      artifact,
      runsDir: config.runsDir,
      runId,
      ...(store ? { presignGet: (storageKey: string) => store.presignDownload({ key: storageKey }) } : {}),
    });
    if (!plan) {
      throw invalidRequest('artifact path escapes the run directory', { path: artifactPath });
    }
    if (plan.kind === 'redirect') return c.redirect(plan.url, 302);

    let body: Buffer;
    try {
      body = await readFile(plan.path);
    } catch {
      throw new ApiError(
        'artifact_not_found',
        404,
        `artifact "${artifactPath}" is not available on this host`,
        { runId, path: artifactPath },
      );
    }

    return new Response(body, {
      status: 200,
      headers: {
        'content-type': plan.contentType,
        'content-length': String(body.byteLength),
        'content-disposition': contentDispositionForArtifact(artifactPath),
        'cache-control': 'private, no-store',
      },
    });
  });

  api.get('/factories/:factoryId/runs/:id/events', async (c) => {
    const runId = c.req.param('id');
    const record = await factoryOf(c);
    const run = await assertRunAccess(runId, viewerOf(config, c.get('user')), record.id);
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

  api.post('/factories/:factoryId/runs/:id/cancel', async (c) => {
    const runId = c.req.param('id');
    const record = await factoryOf(c);
    const run = await assertRunAccess(runId, viewerOf(config, c.get('user')), record.id);
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

  api.post('/factories/:factoryId/runs/:id/retry', async (c) => {
    const record = await factoryOf(c);
    const result = await retryRun(
      config,
      c.req.param('id'),
      viewerOf(config, c.get('user')),
      record.id,
    );
    log('info', 'run_retried', {
      from: result.retryOf,
      to: result.run.id,
      deduped: result.deduped,
    });
    return c.json(
      {
        run: summarize(result.run),
        ...(result.workflow ? { workflow: result.workflow } : {}),
        ...(result.proxy ? { proxy: result.proxy } : {}),
        retryOf: result.retryOf,
        deduped: result.deduped,
      },
      result.deduped ? 200 : 201,
    );
  });

  /* ----------------------------------------------------------- permissions */

  api.post('/factories/:factoryId/runs/:id/permissions/:requestId', async (c) => {
    const runId = c.req.param('id');
    const requestId = c.req.param('requestId');
    const record = await factoryOf(c);
    const run = await assertRunAccess(runId, viewerOf(config, c.get('user')), record.id);
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

  api.post('/factories/:factoryId/work-items', async (c) => {
    const body = await json<CreateWorkItemBody>(c, createWorkItemBodySchema);
    const record = await factoryOf(c);
    const created = await createWorkItemForApi(
      config,
      record.key,
      body,
      sessionUserId(config, c.get('user')),
      record.id,
    );
    return c.json(created, 201);
  });

  api.get('/factories/:factoryId/work-items', async (c) => {
    const limit = Number(c.req.query('limit') ?? '50');
    const offset = Number(c.req.query('offset') ?? '0');
    const record = await factoryOf(c);
    const viewer = viewerOf(config, c.get('user'));

    // `view=board` is the batch projection: summary + pending gate + run-link events in one
    // query, with server-side status filtering and cursor pagination.
    if (c.req.query('view') === 'board') {
      const statuses = (c.req.query('status') ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      return c.json(
        await listWorkItemBoardForApi(
          record.key,
          {
            ...(statuses.length > 0 ? { statuses } : {}),
            limit: Number.isFinite(limit) ? limit : 40,
            cursor: decodeCursor(c.req.query('cursor')),
          },
          viewer,
        ),
      );
    }

    const workItems = await listWorkItemsForApi(
      {
        factory: record.key,
        ...(c.req.query('stage') ? { stage: c.req.query('stage') as string } : {}),
        ...(c.req.query('status') ? { status: c.req.query('status') as string } : {}),
        limit: Number.isFinite(limit) ? limit : 50,
        offset: Number.isFinite(offset) ? offset : 0,
      },
      viewer,
    );
    return c.json({ workItems });
  });

  api.get('/factories/:factoryId/work-items/:id', async (c) => {
    const record = await factoryOf(c);
    return c.json(
      await getWorkItemDetail(
        c.req.param('id'),
        viewerOf(config, c.get('user')),
        record.id,
      ),
    );
  });

  api.post('/factories/:factoryId/work-items/:id/cancel', async (c) => {
    const body = await json<CancelWorkItemBody>(c, cancelWorkItemBodySchema);
    const record = await factoryOf(c);
    return c.json(
      await cancelWorkItemForApi(
        config,
        c.req.param('id'),
        body,
        viewerOf(config, c.get('user')),
        record.id,
      ),
    );
  });

  api.post('/factories/:factoryId/work-items/:id/retry', async (c) => {
    const body = await json<RetryWorkItemBody>(c, retryWorkItemBodySchema);
    const record = await factoryOf(c);
    const result = await retryWorkItemForApi(
      config,
      c.req.param('id'),
      body,
      viewerOf(config, c.get('user')),
      record.id,
    );
    log('info', 'work_item_retry_requested', {
      workItemId: c.req.param('id'),
      actor: body.actor,
      attempt: result.attempt,
      deduped: result.deduped,
    });
    return c.json(result, result.deduped ? 200 : 201);
  });

  api.post('/factories/:factoryId/work-items/:id/gates/:stage', async (c) => {
    const body = await json<GateDecisionRequest>(c, gateDecisionBodySchema);
    const record = await factoryOf(c);
    const result = await submitGateDecisionForApi(
      config,
      c.req.param('id'),
      c.req.param('stage'),
      body,
      viewerOf(config, c.get('user')),
      record.id,
    );
    return c.json(result);
  });

  /* ------------------------------------------------------------- autonomy */

  api.get('/factories/:factoryId/autonomy', async (c) =>
    c.json({ autonomy: await getAutonomyForApi(config, (await factoryOf(c)).key) }),
  );

  api.post('/factories/:factoryId/autonomy', async (c) => {
    const body = await json<AutonomyBody>(c, autonomyBodySchema);
    return c.json({
      autonomy: await setAutonomyForApi(config, (await factoryOf(c)).key, body),
    });
  });

  api.get('/factories/:factoryId/governance', async (c) =>
    c.json(await getGovernanceForApi(config, (await factoryOf(c)).key)),
  );

  api.get('/factories/:factoryId/governance/audit', async (c) => {
    const view = await getGovernanceForApi(config, (await factoryOf(c)).key);
    return c.json({
      factory: view.factory,
      auditExport: view.governance?.audit ?? { export: 'jsonl', otlpEndpoint: null },
      decisions: view.recentDecisions,
    });
  });

  /* ------------------------------------------------------------------ chat */

  api.post('/factories/:factoryId/chat', async (c) => {
    const body = await json<Omit<CreateRunBody, 'factory'>>(c, chatBodySchema);
    const record = await factoryOf(c);
    const created = await createRun(
      config,
      { ...body, factory: record.key },
      { kind: 'chat', factoryId: record.id },
      sessionUserId(config, c.get('user')),
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
    api.post('/factories/:factoryId/runs/:id/proxy-token', async (c) => {
      const runId = c.req.param('id');
      const record = await factoryOf(c);
      const run = await assertRunAccess(runId, viewerOf(config, c.get('user')), record.id);
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

  registerWebhooks(api, config, factoryOf);
  registerIntake(api, config, factoryOf);

  /* ------------------------------------------------------------- runners */

  // Console-facing control plane: hosts, enrollments, metrics, alerts and rules. Registered
  // on the auth-protected router, so owner/admin scope applies like every other resource.
  registerRunners(api, config);

  // Agent routes are authenticated by a per-host bearer token, not a console session, so
  // they live on the root app and bypass `authMiddleware` (`AUTH_REQUIRED=1` must not lock
  // a remote agent out). Registered before the sub-app mount so the `/api/v1/*` session
  // middleware cannot intercept them.
  registerRunnerAgent(app, config);

  // One prefix for every resource route (ADR-030): the sub-app's routes are copied here
  // with `API_PREFIX` prepended. Unversioned resource paths therefore 404.
  //
  // The cast is a Hono typing artefact: `Variables` is invariant, so a sub-app that declares
  // the auth context cannot be passed to an untyped parent. The runtime contract is the
  // same — `authMiddleware` populates `user` for every route registered on `api`.
  app.route(API_PREFIX, api as unknown as Hono);

  // The OpenAI-compatible inference passthrough (`/v1/*`) and the dev-only stub upstream
  // (`/internal/*`) are protocol endpoints, not versioned resources (see `routes.ts`).
  registerProxy(app, config);

  return app;
}

/** Public route table (`METHOD path`, OpenAPI templated) used by the parity contract test. */
export function servedRoutes(config: ApiConfig): RouteEntry[] {
  return createApp(config)
    .routes.filter((route) => route.method !== 'ALL' && isPublicRoute(route.path))
    .map((route) => ({ method: route.method.toUpperCase(), path: openApiPath(route.path) }))
    .sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
}
