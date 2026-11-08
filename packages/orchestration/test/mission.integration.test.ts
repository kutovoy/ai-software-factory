import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { join } from 'node:path';
import {
  createMission,
  getMission,
  listMissionFeatures,
  newMissionId,
  setAutonomyState,
  type Mission,
} from '@factory/core';
import {
  completeMissionValidationActivity,
  createMissionFeatureWorkItemActivity,
  loadMissionStateActivity,
  missionPlanAutoApprovalActivity,
  planFixFeaturesActivity,
  planMissionActivity,
  persistMissionPlanActivity,
  prepareMissionValidationActivity,
  recordMissionCheckpointActivity,
  setMissionStatusActivity,
} from '../src/activities/mission';
import { closeSql, getSql, setSql } from '../src/db';
import { deterministicMissionPlanner, setMissionPlanner } from '../src/models/mission-planner';
import type { MissionPlanData } from '../src/types';

/**
 * Mission orchestration integration test. It needs Postgres but no Temporal: it exercises
 * the activity boundaries (plan persistence, feature work-item creation, validation run
 * preparation/completion, fix-feature planning). Opt-in:
 *
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory RUN_INTEGRATION=1 \
 *   bun test packages/orchestration/test/mission.integration.test.ts
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const FACTORY_ROOT = join(REPO_ROOT, 'factories', 'example');
const HELLO_ROOT = join(REPO_ROOT, 'factories', 'hello-nextjs');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');

async function migrate(databaseUrl: string): Promise<void> {
  const sql = new SQL(databaseUrl, { max: 1 });
  try {
    await sql`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = new Set(
      ((await sql`select name from schema_migrations`) as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    const { readdir, readFile } = await import('node:fs/promises');
    const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await sql.unsafe(await readFile(join(MIGRATIONS, file), 'utf8'));
      await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
  } finally {
    await sql.close();
  }
}

suite('mission activities', () => {
  let mission: Mission;
  let firstPlan: MissionPlanData | null = null;
  let previousHarness: string | undefined;

  beforeAll(async () => {
    await migrate(process.env.DATABASE_URL as string);
    setSql(new SQL(process.env.DATABASE_URL as string, { max: 2 }));
    setMissionPlanner(deterministicMissionPlanner);
    previousHarness = process.env.MISSION_HARNESS;
    process.env.MISSION_HARNESS = 'fake';

    mission = await createMission(getSql(), {
      id: newMissionId(),
      factory: 'example',
      title: 'Health endpoint mission',
      goal: 'Add a health endpoint\nExpose it on /health',
      definitionCommit: 'itest123',
      factoryRoot: FACTORY_ROOT,
      budget: { maxRuns: 20 },
    });
  });

  afterAll(async () => {
    const sql = getSql();
    await sql`delete from runs where mission_id = ${mission.id}`;
    await sql`delete from work_items where mission_id = ${mission.id}`;
    await sql`delete from missions where id = ${mission.id}`;
    setMissionPlanner(null);
    if (previousHarness === undefined) delete process.env.MISSION_HARNESS;
    else process.env.MISSION_HARNESS = previousHarness;
    await closeSql();
  });

  test('plans, persists and loads a mission', async () => {
    const plan = await planMissionActivity({
      missionId: mission.id,
      factory: mission.factory,
      definitionCommit: mission.definitionCommit,
      title: mission.title,
      goal: mission.goal,
      createdAt: '2026-11-06T00:00:00.000Z',
    });
    expect(plan.milestones[0]?.features).toHaveLength(2);
    firstPlan = plan;

    await persistMissionPlanActivity({ missionId: mission.id, plan, planVersion: 1 });
    const state = await loadMissionStateActivity({ missionId: mission.id });
    expect(state.plan?.milestones[0]?.features).toHaveLength(2);
    expect(state.features).toHaveLength(2);
    expect(state.featureStatuses[state.features[0]!.id]).toBe('pending');
    expect(state.cancelRequested).toBe(false);
  });

  test('creates a feature work item at implement with the mission links', async () => {
    const state = await loadMissionStateActivity({ missionId: mission.id });
    const feature = state.features[0]!;
    const created = await createMissionFeatureWorkItemActivity({
      missionId: mission.id,
      featureId: feature.id,
    });

    expect(created.input.resume?.currentStage).toBe('implement');
    expect(created.input.stageGraph.order.indexOf('implement')).toBe(
      created.input.resume?.stageIndex as number,
    );
    expect(created.input.stageGraph.order).not.toContain('verify');
    expect(created.input.factoryRoot).toBe(FACTORY_ROOT);
    expect(created.input.harnessOverride).toBe('fake');

    const sql = getSql();
    const rows = (await sql`
      select source, stage, mission_id, mission_feature_id, status
      from work_items where id = ${created.workItemId}
    `) as {
      source: string;
      stage: string;
      mission_id: string;
      mission_feature_id: string;
      status: string;
    }[];
    expect(rows[0]).toMatchObject({
      source: 'mission',
      stage: 'implement',
      mission_id: mission.id,
      mission_feature_id: feature.id,
      status: 'active',
    });

    const linked = (await listMissionFeatures(sql, mission.id)).find(
      (entry) => entry.id === feature.id,
    );
    expect(linked?.workItemId).toBe(created.workItemId);
    expect(linked?.status).toBe('running');
  });

  test('prepares and completes a fresh validation run', async () => {
    const state = await loadMissionStateActivity({ missionId: mission.id });
    const milestone = state.milestones[0]!;
    const assertionIds = state.plan!.validationContract.assertions.map(
      (assertion) => assertion.id,
    );

    const prepared = await prepareMissionValidationActivity({
      missionId: mission.id,
      milestoneId: milestone.id,
      round: 1,
      kind: 'scrutiny',
    });
    expect(prepared.input.missionId).toBe(mission.id);
    expect(prepared.input.runId).toContain('_val_1_scrutiny');

    const sql = getSql();
    const summary = JSON.stringify({
      validation: assertionIds.map((id) => ({ id, status: 'pass', evidence: 'ok' })),
    });
    await sql`
      update runs set status = 'ok', summary = ${summary} where id = ${prepared.input.runId}
    `;

    const completion = await completeMissionValidationActivity({
      missionId: mission.id,
      milestoneId: milestone.id,
      validationId: prepared.validationId,
      runId: prepared.input.runId,
      round: 1,
      kind: 'scrutiny',
    });
    expect(completion.passed).toBe(true);
    expect(completion.missing).toEqual([]);

    const validations = (await sql`
      select status, verdict from mission_validations where id = ${prepared.validationId}
    `) as { status: string; verdict: string }[];
    expect(validations[0]).toMatchObject({ status: 'passed', verdict: 'approve' });
  });

  test('creates one linked fix feature per failed assertion', async () => {
    const state = await loadMissionStateActivity({ missionId: mission.id });
    const milestone = state.milestones[0]!;
    const feature = state.features[0]!;
    const assertion = state.plan!.validationContract.assertions[0]!;

    const planned = await planFixFeaturesActivity({
      missionId: mission.id,
      milestoneId: milestone.id,
      round: 1,
      planVersion: 1,
      findings: [
        {
          assertionId: assertion.id,
          featureId: feature.id,
          title: assertion.title,
          assertion: assertion.assertion,
          status: 'missing',
          required: true,
          detail: 'no evidence',
        },
      ],
    });

    expect(planned.features).toHaveLength(1);
    expect(planned.features[0]?.fixForFeatureId).toBe(feature.id);
    expect(planned.features[0]?.dependsOn).toEqual([]);
    expect(planned.features[0]?.acceptanceCheckIds).toEqual([assertion.id]);
    expect(planned.plan.milestones[0]?.features).toHaveLength(3);
  });

  test('rejects plan ids that already belong to another mission', async () => {
    expect(firstPlan).not.toBeNull();
    const second = await createMission(getSql(), {
      id: newMissionId(),
      factory: 'example',
      title: 'Second mission',
      goal: 'Should not steal the first plan rows',
      definitionCommit: 'itest123',
      factoryRoot: FACTORY_ROOT,
    });

    try {
      await expect(
        persistMissionPlanActivity({
          missionId: second.id,
          plan: { ...firstPlan!, missionId: second.id },
          planVersion: 1,
        }),
      ).rejects.toThrow(/belongs to another mission/);
    } finally {
      await getSql()`delete from missions where id = ${second.id}`;
    }
  });

  test('auto-approves a plan only for full autonomy with a satisfied gate', async () => {
    const sql = getSql();
    const mission = await createMission(sql, {
      id: newMissionId(),
      factory: 'itest-autonomy',
      title: 'Autonomy plan',
      goal: 'Check the auto-approval policy',
      definitionCommit: 'itest123',
      factoryRoot: HELLO_ROOT,
    });

    try {
      await setAutonomyState(sql, {
        factory: 'itest-autonomy',
        enabled: true,
        paused: false,
        actor: 'itest',
        reason: 'auto-approval integration test',
        overrideActor: 'itest',
        overrideReason: 'audited override',
      });

      const auto = await missionPlanAutoApprovalActivity({ missionId: mission.id });
      expect(auto.autoApprove).toBe(true);
      expect(auto.autonomyLevel).toBe('full');
      expect(auto.benchmarkGateSatisfied).toBe(true);

      await setAutonomyState(sql, {
        factory: 'itest-autonomy',
        enabled: true,
        paused: true,
        actor: 'itest',
        reason: 'paused auto-approval integration test',
        overrideActor: 'itest',
        overrideReason: 'audited override',
      });
      const paused = await missionPlanAutoApprovalActivity({ missionId: mission.id });
      expect(paused.autoApprove).toBe(false);
    } finally {
      await sql`delete from missions where id = ${mission.id}`;
      await sql`delete from autonomy_state where factory = 'itest-autonomy'`;
    }
  });

  test('does not auto-approve a high-risk plan', async () => {
    const sql = getSql();
    const mission = await createMission(sql, {
      id: newMissionId(),
      factory: 'itest-autonomy',
      title: 'High-risk autonomy plan',
      goal: 'Add authentication\nSupport login',
      definitionCommit: 'itest123',
      factoryRoot: HELLO_ROOT,
    });

    try {
      await setAutonomyState(sql, {
        factory: 'itest-autonomy',
        enabled: true,
        paused: false,
        actor: 'itest',
        reason: 'high-risk auto-approval integration test',
        overrideActor: 'itest',
        overrideReason: 'audited override',
      });

      const plan = await planMissionActivity({
        missionId: mission.id,
        factory: mission.factory,
        definitionCommit: mission.definitionCommit,
        title: mission.title,
        goal: mission.goal,
        createdAt: '2026-11-06T00:00:00.000Z',
      });
      expect(plan.riskTier).toBe('high');
      await persistMissionPlanActivity({ missionId: mission.id, plan, planVersion: 1 });

      const auto = await missionPlanAutoApprovalActivity({ missionId: mission.id });
      expect(auto.autoApprove).toBe(false);
      expect(auto.riskTier).toBe('high');
      expect(auto.riskPolicy.planApproval).toBe('human');
      expect(auto.riskPolicy.review).toBe('human');
      expect(auto.riskPolicy.merge).toBe('human');
    } finally {
      await sql`delete from missions where id = ${mission.id}`;
      await sql`delete from autonomy_state where factory = 'itest-autonomy'`;
    }
  });

  test('high-risk feature work items force human review/ship gates and human merge', async () => {
    const sql = getSql();
    const high = await createMission(sql, {
      id: newMissionId(),
      factory: 'itest-features',
      title: 'High-risk feature',
      goal: 'Add authentication\nSupport login',
      definitionCommit: 'itest123',
      factoryRoot: HELLO_ROOT,
    });
    const low = await createMission(sql, {
      id: newMissionId(),
      factory: 'itest-features',
      title: 'Low-risk feature',
      goal: 'Add a footer\nStyle it',
      definitionCommit: 'itest123',
      factoryRoot: HELLO_ROOT,
    });

    try {
      for (const [mission, expectedTier] of [
        [high, 'high'],
        [low, 'low'],
      ] as const) {
        const plan = await planMissionActivity({
          missionId: mission.id,
          factory: mission.factory,
          definitionCommit: mission.definitionCommit,
          title: mission.title,
          goal: mission.goal,
          createdAt: '2026-11-06T00:00:00.000Z',
        });
        expect(plan.riskTier).toBe(expectedTier);
        await persistMissionPlanActivity({ missionId: mission.id, plan, planVersion: 1 });

        const features = await listMissionFeatures(sql, mission.id);
        const feature = features[0]!;
        const created = await createMissionFeatureWorkItemActivity({
          missionId: mission.id,
          featureId: feature.id,
        });

        expect(created.input.riskTier).toBe(expectedTier);
        expect(created.input.planRef).toBe(`${mission.id}#${feature.id}`);
        expect(created.input.sourceRef.riskTier).toBe(expectedTier);
        expect(Array.isArray(created.input.architectureImpact)).toBe(true);
        expect(Array.isArray(created.input.openQuestions)).toBe(true);

        if (expectedTier === 'high') {
          expect(created.input.riskPolicy?.review).toBe('human');
          expect(created.input.riskPolicy?.merge).toBe('human');
          expect(created.input.gates.review).toBe('human');
          expect(created.input.gates.ship).toBe('human');
          expect(created.input.mergePolicy).toBe('human');
        } else {
          expect(created.input.riskPolicy?.review).toBe('agent');
          expect(created.input.gates.review).toBe('agent');
          expect(created.input.mergePolicy).toBe('auto_on_green');
        }
      }
    } finally {
      await sql`delete from work_items where mission_id in (${high.id}, ${low.id})`;
      await sql`delete from missions where id in (${high.id}, ${low.id})`;
    }
  });

  test('records checkpoints and status transitions', async () => {
    const checkpoint = await recordMissionCheckpointActivity({
      missionId: mission.id,
      kind: 'feature.done',
      dedupeKey: 'itest:feature',
      state: { title: 'Health endpoint' },
    });
    expect(checkpoint.kind).toBe('feature.done');
    expect(checkpoint.state.title).toBe('Health endpoint');

    const updated = await setMissionStatusActivity({
      missionId: mission.id,
      status: 'blocked',
      error: 'itest',
    });
    expect(updated?.status).toBe('blocked');
    const reloaded = await getMission(getSql(), mission.id);
    expect(reloaded?.status).toBe('blocked');
  });
});
