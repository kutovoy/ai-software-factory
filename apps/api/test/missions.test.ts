import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { SQL } from 'bun';
import {
  closeClient,
  getSql,
  setSql,
} from '@factory/orchestration';
import {
  createMission,
  createMissionGate,
  missionControlBodySchema,
  missionPlanDecisionBodySchema,
  missionRetryFeatureBodySchema,
  newMissionFeatureId,
  newMissionId,
  newMissionMilestoneId,
} from '@factory/core';
import {
  createMissionBodySchema,
  createMissionForApi,
  getMissionDetailForApi,
  retryMissionFeatureForApi,
} from '../src/missions';
import { createApp, servedRoutes } from '../src/app';
import { loadApiConfig, type ApiConfig } from '../src/config';
import { ApiError } from '../src/errors';
import type { FactoryRecord } from '../src/factories';
import { API_PREFIX, routeKey, type RouteEntry } from '../src/routes';
import { factoryIdOf, req } from './helpers';

/**
 * Mission API tests (change `add-long-running-missions`, spec `http-api` › Mission API).
 *
 * The first two suites are always on: they cover request schemas, the registered route
 * surface, and error mapping paths that fail before any database/Temporal call. The last
 * suite is the opt-in integration run:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test apps/api/test/missions.test.ts
 *
 * Like the work-item suite, it starts real workflows on a dedicated task queue with no
 * worker, so the API routes are exercised without racing the compose worker.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');
const JSON_HEADERS = { 'content-type': 'application/json' };

const unitConfig = (): ApiConfig =>
  loadApiConfig({
    DATABASE_URL:
      process.env.DATABASE_URL ?? 'postgres://factory:factory@localhost:5433/factory',
    FACTORY_ROOT: join(REPO_ROOT, 'factories'),
    REPO_ROOT,
  });

/** A record shaped like the registry row `factoryOf` hands to the mission services. */
function fakeFactoryRecord(key: string): FactoryRecord {
  return {
    id: null,
    key,
    path: key,
    name: key,
    dir: join(REPO_ROOT, 'factories', key),
    legacy: true,
    ownerUsername: null,
    ownerId: null,
    manifestName: key,
    alias: null,
    description: null,
    repoCount: 0,
    resourceCount: 0,
    valid: true,
    errorCount: 0,
    version: null,
  };
}

async function expectApiError(
  run: () => Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect({ status: apiError.status, code: apiError.code }).toEqual({ status, code });
    return;
  }
  throw new Error(`expected ApiError ${status} ${code}, but the call resolved`);
}

describe('mission request schemas', () => {
  test('create accepts title, goal, optional budget and plan', () => {
    const parsed = createMissionBodySchema.parse({
      title: 'Ship checkout',
      goal: 'A working checkout flow',
      budget: { maxCostUsd: 25, maxRuns: 40 },
      plan: { version: 'v1alpha1' },
    });
    expect(parsed.title).toBe('Ship checkout');
    expect(parsed.budget?.maxRuns).toBe(40);
    expect(parsed.plan).toEqual({ version: 'v1alpha1' });
  });

  test('create rejects empty fields, unknown keys and invalid budget caps', () => {
    expect(createMissionBodySchema.safeParse({ title: '', goal: 'x' }).success).toBe(false);
    expect(createMissionBodySchema.safeParse({ title: 'x', goal: '' }).success).toBe(false);
    expect(
      createMissionBodySchema.safeParse({ title: 'x', goal: 'y', extra: true }).success,
    ).toBe(false);
    expect(
      createMissionBodySchema.safeParse({
        title: 'x',
        goal: 'y',
        budget: { maxCostUsd: -1 },
      }).success,
    ).toBe(false);
  });

  test('plan decisions accept only approve, reject or request_changes', () => {
    expect(
      missionPlanDecisionBodySchema.parse({ decision: 'approve', actor: 'ada' }).decision,
    ).toBe('approve');
    expect(
      missionPlanDecisionBodySchema.safeParse({ decision: 'ship', actor: 'ada' }).success,
    ).toBe(false);
    expect(missionPlanDecisionBodySchema.safeParse({ decision: 'approve' }).success).toBe(false);
    expect(
      missionPlanDecisionBodySchema.safeParse({
        decision: 'approve',
        actor: 'ada',
        extra: 'nope',
      }).success,
    ).toBe(false);
  });

  test('control and retry bodies require an actor', () => {
    expect(missionControlBodySchema.safeParse({}).success).toBe(false);
    expect(missionControlBodySchema.safeParse({ actor: 'ada', reason: 'lunch' }).success).toBe(
      true,
    );
    expect(missionRetryFeatureBodySchema.safeParse({ actor: 'ada' }).success).toBe(true);
    expect(missionRetryFeatureBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('mission route surface', () => {
  const expected: RouteEntry[] = [
    { method: 'POST', path: `${API_PREFIX}/factories/{factoryId}/missions` },
    { method: 'GET', path: `${API_PREFIX}/factories/{factoryId}/missions` },
    { method: 'GET', path: `${API_PREFIX}/factories/{factoryId}/missions/{id}` },
    { method: 'POST', path: `${API_PREFIX}/factories/{factoryId}/missions/{id}/gates/plan` },
    { method: 'POST', path: `${API_PREFIX}/factories/{factoryId}/missions/{id}/pause` },
    { method: 'POST', path: `${API_PREFIX}/factories/{factoryId}/missions/{id}/resume` },
    { method: 'POST', path: `${API_PREFIX}/factories/{factoryId}/missions/{id}/cancel` },
    {
      method: 'POST',
      path: `${API_PREFIX}/factories/{factoryId}/missions/{id}/features/{featureId}/retry`,
    },
  ];

  test('every mission route is registered under the versioned prefix', () => {
    const served = new Set(servedRoutes(unitConfig()).map(routeKey));
    expect(expected.filter((route) => !served.has(routeKey(route)))).toEqual([]);
  });

  test('unversioned mission paths are not served', async () => {
    const app = createApp(unitConfig());
    for (const path of ['/missions', '/factories/fac_x/missions']) {
      const response = await app.request(path);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  });
});

describe('mission error mapping without a database', () => {
  const config = unitConfig();
  const record = fakeFactoryRecord('example');

  test('a malformed mission id is mission_not_found, not a database error', async () => {
    await expectApiError(
      () => getMissionDetailForApi(record, 'mis_not-a-ulid', null),
      404,
      'mission_not_found',
    );
  });

  test('a malformed feature id is mission_feature_not_found', async () => {
    await expectApiError(
      () =>
        retryMissionFeatureForApi(
          config,
          record,
          'mis_00000000000000000000000000',
          'nope',
          { actor: 'ada' },
          null,
        ),
      404,
      'mission_feature_not_found',
    );
  });

  test('a plan that is not a JSON object is invalid_request', async () => {
    await expectApiError(
      () =>
        createMissionForApi(
          config,
          record,
          { title: 'Plan', goal: 'Ship it', plan: [] },
          null,
        ),
      400,
      'invalid_request',
    );
  });

  test('a structurally invalid plan is invalid_mission_plan', async () => {
    await expectApiError(
      () =>
        createMissionForApi(
          config,
          record,
          {
            title: 'Plan',
            goal: 'Ship it',
            plan: { version: 'v1alpha1', milestones: [] },
          },
          null,
        ),
      422,
      'invalid_mission_plan',
    );
  });

  test('a plan with an unknown dependency is invalid_mission_plan', async () => {
    const plan = {
      version: 'v1alpha1',
      title: 'Plan',
      goal: 'Ship it',
      validationContract: {
        version: 'v1alpha1',
        enforce: true,
        assertions: [
          {
            id: 'a1',
            title: 'Checkout works',
            assertion: 'A user can complete checkout',
            tier: 'e2e',
            required: true,
            tool: 'playwright',
            evidence: 'screenshot',
          },
        ],
        risks: [],
        source: 'human',
      },
      milestones: [
        {
          id: newMissionMilestoneId(),
          title: 'M1',
          description: 'first',
          order: 0,
          features: [
            {
              id: newMissionFeatureId(),
              title: 'F1',
              description: 'first feature',
              order: 0,
              dependsOn: [newMissionFeatureId()],
              acceptanceCheckIds: ['a1'],
            },
          ],
        },
      ],
      risks: [],
      assumptions: [],
    };
    await expectApiError(
      () =>
        createMissionForApi(
          config,
          record,
          { title: 'Plan', goal: 'Ship it', plan },
          null,
        ),
      422,
      'invalid_mission_plan',
    );
  });
});

/* -------------------------------------------------------------- integration */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const createdMissions: string[] = [];

async function migrate(databaseUrl: string): Promise<void> {
  const runner = new SQL(databaseUrl, { max: 1 });
  try {
    await runner`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = new Set(
      ((await runner`select name from schema_migrations`) as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await runner.unsafe(await readFile(join(MIGRATIONS, file), 'utf8'));
      await runner`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
  } finally {
    await runner.close();
  }
}

function missionPlan(title: string): Record<string, unknown> {
  return {
    version: 'v1alpha1',
    title,
    goal: `Goal for ${title}`,
    validationContract: {
      version: 'v1alpha1',
      enforce: true,
      assertions: [
        {
          id: 'a1',
          title: 'The feature works',
          assertion: 'Exercise the feature end to end',
          tier: 'e2e',
          required: true,
          tool: 'playwright',
          evidence: 'screenshot',
        },
      ],
      risks: [],
      source: 'human',
    },
    milestones: [
      {
        id: newMissionMilestoneId(),
        title: 'Milestone 1',
        description: 'The first milestone',
        order: 0,
        features: [
          {
            id: newMissionFeatureId(),
            title: 'Feature 1',
            description: 'The first feature',
            order: 0,
            dependsOn: [],
            acceptanceCheckIds: ['a1'],
          },
        ],
      },
    ],
    risks: [],
    assumptions: [],
  };
}

suite('mission API integration', () => {
  let config: ApiConfig;
  let app: Hono;
  let exampleId: string;
  let lightsOffId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL as string;
    process.env.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS as string;
    process.env.TEMPORAL_TASK_QUEUE = `factory-api-missions-itest-${process.pid}-${Date.now()}`;
    process.env.FACTORY_ROOT = join(REPO_ROOT, 'factories');
    process.env.REPO_ROOT = REPO_ROOT;

    await migrate(process.env.DATABASE_URL as string);
    // The unit suites may have seeded the SQL singleton with a different URL.
    setSql(null);
    config = loadApiConfig();
    app = createApp(config);
    exampleId = await factoryIdOf(app, 'example');
    lightsOffId = await factoryIdOf(app, 'example-lights-off');
  }, 60_000);

  afterAll(async () => {
    const sql = getSql();
    for (const id of createdMissions) {
      await sql`delete from missions where id = ${id}`;
    }
    await closeClient();
  }, 30_000);

  async function postJson(path: string, body: unknown): Promise<Response> {
    return await req(app, path, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  }

  test('POST /missions creates a planning mission and starts the workflow', async () => {
    const response = await postJson(`/factories/${exampleId}/missions`, {
      title: 'Add a checkout flow',
      goal: 'A user can buy a product',
      budget: { maxRuns: 25, maxCostUsd: 10 },
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      mission: {
        id: string;
        factory: string;
        factoryId: string;
        status: string;
        definitionCommit: string;
        workflowId: string;
        budget: { maxRuns?: number };
      };
      workflow: { workflowId: string; temporalRunId: string } | null;
    };
    createdMissions.push(body.mission.id);

    expect(body.mission.id).toMatch(/^mis_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.mission.factory).toBe('example');
    expect(body.mission.factoryId).toBe(exampleId);
    expect(body.mission.status).toBe('planning');
    expect(body.mission.definitionCommit.length).toBeGreaterThan(6);
    expect(body.mission.workflowId).toBe(`mission-${body.mission.id}`);
    expect(body.mission.budget.maxRuns).toBe(25);
    expect(body.workflow?.workflowId).toBe(`mission-${body.mission.id}`);
  }, 60_000);

  test('POST /missions persists a supplied plan and lists progress', async () => {
    const response = await postJson(`/factories/${exampleId}/missions`, {
      title: 'Ship the plan',
      goal: 'Ship the supplied plan',
      plan: missionPlan('Ship the plan'),
    });
    expect(response.status).toBe(201);

    const created = (await response.json()) as {
      mission: { id: string; planVersion: number; plan: { milestones: unknown[] } | null; featureTotal: number };
    };
    createdMissions.push(created.mission.id);
    expect(created.mission.planVersion).toBe(1);
    expect(created.mission.plan?.milestones).toHaveLength(1);
    expect(created.mission.featureTotal).toBe(1);

    const list = await req(app, `/factories/${exampleId}/missions?status=planning&limit=50`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      missions: Array<{ id: string; featureTotal: number; spendUsd: number }>;
    };
    const row = listed.missions.find((mission) => mission.id === created.mission.id);
    expect(row?.featureTotal).toBe(1);
    expect(row?.spendUsd).toBe(0);

    const detail = await req(app, `/factories/${exampleId}/missions/${created.mission.id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      mission: { id: string };
      milestones: unknown[];
      features: Array<{ id: string; status: string }>;
      events: Array<{ type: string }>;
      pendingGate: unknown;
      workItems: unknown[];
      budget: { usage: { runs: number } };
    };
    expect(detailBody.mission.id).toBe(created.mission.id);
    expect(detailBody.milestones).toHaveLength(1);
    expect(detailBody.features).toHaveLength(1);
    expect(detailBody.features[0]?.status).toBe('pending');
    expect(detailBody.events.map((event) => event.type)).toContain('mission.created');
    expect(detailBody.pendingGate).toBeNull();
    expect(detailBody.workItems).toEqual([]);
    expect(detailBody.budget.usage.runs).toBe(0);
  }, 60_000);

  test('a mission is not readable through another factory id', async () => {
    const response = await req(
      app,
      `/factories/${lightsOffId}/missions/${createdMissions[0]}`,
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe('mission_not_found');
  });

  test('an unknown mission id is mission_not_found', async () => {
    const response = await req(
      app,
      `/factories/${exampleId}/missions/mis_00000000000000000000000000`,
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe('mission_not_found');
  });

  test('plan decision, pause, resume and cancel drive the read model', async () => {
    // The workflow is deliberately never started: the API writes the read model first and
    // reports `delivery: failed` when Temporal has no such workflow. This keeps the test
    // off the Update path that needs a worker.
    const sql = getSql();
    const missionId = newMissionId();
    const workflowId = `mission-${missionId}`;
    createdMissions.push(missionId);
    await createMission(sql, {
      id: missionId,
      factory: 'example',
      factoryId: exampleId,
      title: 'Control mission',
      goal: 'Exercise plan approval and controls',
      definitionCommit: 'deadbeefdeadbeef',
      factoryRoot: join(REPO_ROOT, 'factories', 'example'),
      workflowId,
      createdBy: null,
    });
    await createMissionGate(sql, {
      missionId,
      gate: 'plan',
      attempt: 1,
      workflowId,
    });

    const decided = await postJson(
      `/factories/${exampleId}/missions/${missionId}/gates/plan`,
      { decision: 'approve', actor: 'ada', reason: 'plan looks good' },
    );
    expect(decided.status).toBe(200);
    const decision = (await decided.json()) as {
      decision: string;
      actor: string;
      gate: string;
      attempt: number;
      delivery: string;
    };
    expect(decision).toMatchObject({
      decision: 'approve',
      actor: 'ada',
      gate: 'plan',
      attempt: 1,
    });
    expect(['update', 'signal', 'failed', 'none']).toContain(decision.delivery);
    // No workflow was started, so the Update/Signal cannot land; the read model still did.
    expect(decision.delivery).toBe('failed');

    const repeat = await postJson(
      `/factories/${exampleId}/missions/${missionId}/gates/plan`,
      { decision: 'approve', actor: 'ada' },
    );
    expect(repeat.status).toBe(404);
    expect(((await repeat.json()) as { code: string }).code).toBe('gate_not_found');

    const paused = await postJson(
      `/factories/${exampleId}/missions/${missionId}/pause`,
      { actor: 'ada', reason: 'hold on' },
    );
    expect(paused.status).toBe(200);
    const pausedBody = (await paused.json()) as {
      mission: { status: string };
      delivery: string;
      alreadyPaused: boolean;
    };
    expect(pausedBody.mission.status).toBe('paused');
    expect(pausedBody.alreadyPaused).toBe(false);
    expect(['signal', 'none']).toContain(pausedBody.delivery);

    const pauseAgain = await postJson(
      `/factories/${exampleId}/missions/${missionId}/pause`,
      { actor: 'ada' },
    );
    expect(((await pauseAgain.json()) as { alreadyPaused: boolean }).alreadyPaused).toBe(true);

    const resumed = await postJson(
      `/factories/${exampleId}/missions/${missionId}/resume`,
      { actor: 'ada' },
    );
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { mission: { status: string } }).mission.status).toBe(
      'running',
    );

    const cancelled = await postJson(
      `/factories/${exampleId}/missions/${missionId}/cancel`,
      { actor: 'ada', reason: 'stop' },
    );
    expect(cancelled.status).toBe(200);
    const cancelledBody = (await cancelled.json()) as {
      mission: { status: string; cancelRequestedAt: string | null };
      cancelled: boolean;
      alreadyCancelled: boolean;
    };
    expect(cancelledBody.mission.status).toBe('cancelled');
    expect(cancelledBody.cancelled).toBe(true);
    expect(cancelledBody.alreadyCancelled).toBe(false);
    expect(cancelledBody.mission.cancelRequestedAt).not.toBeNull();

    const cancelAgain = await postJson(
      `/factories/${exampleId}/missions/${missionId}/cancel`,
      { actor: 'ada' },
    );
    expect(((await cancelAgain.json()) as { alreadyCancelled: boolean }).alreadyCancelled).toBe(
      true,
    );

    const detail = await req(app, `/factories/${exampleId}/missions/${missionId}`);
    const detailBody = (await detail.json()) as {
      events: Array<{ type: string }>;
      gates: Array<{ decision: string | null; actor: string | null }>;
    };
    const cancelledEvents = detailBody.events.filter(
      (event) => event.type === 'mission.cancelled',
    );
    expect(cancelledEvents).toHaveLength(1);
    expect(detailBody.events.map((event) => event.type)).toContain('mission.plan.approved');
    expect(detailBody.gates[0]?.decision).toBe('approve');
    expect(detailBody.gates[0]?.actor).toBe('ada');
  }, 60_000);

  test('feature retry resets a failed feature to pending and records the event', async () => {
    const created = await postJson(`/factories/${exampleId}/missions`, {
      title: 'Retry a feature',
      goal: 'Retry the failed feature',
      plan: missionPlan('Retry a feature'),
    });
    expect(created.status).toBe(201);
    const { mission } = (await created.json()) as { mission: { id: string } };
    createdMissions.push(mission.id);

    const sql = getSql();
    const detail = await req(app, `/factories/${exampleId}/missions/${mission.id}`);
    const detailBody = (await detail.json()) as {
      features: Array<{ id: string; status: string; attempt: number }>;
    };
    const feature = detailBody.features[0] as { id: string; attempt: number };

    await sql`update mission_features set status = 'failed' where id = ${feature.id}`;
    const retried = await postJson(
      `/factories/${exampleId}/missions/${mission.id}/features/${feature.id}/retry`,
      { actor: 'ada', reason: 'transient failure' },
    );
    expect(retried.status).toBe(200);
    const retriedBody = (await retried.json()) as {
      feature: { id: string; status: string; attempt: number };
    };
    expect(retriedBody.feature.status).toBe('pending');
    expect(retriedBody.feature.attempt).toBe(feature.attempt + 1);

    await sql`update mission_features set status = 'running' where id = ${feature.id}`;
    const refused = await postJson(
      `/factories/${exampleId}/missions/${mission.id}/features/${feature.id}/retry`,
      { actor: 'ada' },
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('invalid_state');
  }, 60_000);

  test('list rejects an unknown status filter', async () => {
    const response = await req(app, `/factories/${exampleId}/missions?status=sideways`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('invalid_request');
  });
});
