import { afterEach, describe, expect, test } from 'bun:test';
import {
  MISSION_FEATURE_ID_RE,
  MISSION_MILESTONE_ID_RE,
  validateMissionPlan,
  type MissionPlan,
} from '@factory/core';
import {
  createOpenAIMissionPlanner,
  deterministicMissionPlanner,
  getMissionPlanner,
  setMissionPlanner,
  validatePlannedMission,
  type MissionPlanner,
} from '../src/models/mission-planner';
import type { MissionPlanData } from '../src/types';

const INPUT = {
  missionId: 'mis_01M6QCY01B28JHAMTGNHZRHRRR',
  factory: 'example',
  definitionCommit: 'a1b2c3d4',
  title: 'Add a health endpoint',
  goal: 'Add a health endpoint\nExpose it on /health\nDocument it in the README',
  createdAt: '2026-11-06T00:00:00.000Z',
};

function asPlan(plan: MissionPlanData): MissionPlan {
  return plan as MissionPlan;
}

describe('deterministic mission planner', () => {
  afterEach(() => setMissionPlanner(null));

  test('splits non-empty goal lines into one milestone and valid features', async () => {
    const plan = await deterministicMissionPlanner.plan(INPUT);
    const validation = validateMissionPlan(plan);

    expect(validation.errors).toEqual([]);
    expect(plan.milestones).toHaveLength(1);
    expect(plan.milestones[0]?.features.map((feature) => feature.title)).toEqual([
      'Add a health endpoint',
      'Expose it on /health',
      'Document it in the README',
    ]);
    expect(plan.validationContract.assertions).toHaveLength(3);
    expect(plan.milestones[0]?.features.map((feature) => feature.acceptanceCheckIds)).toEqual([
      ['VAL-1'],
      ['VAL-2'],
      ['VAL-3'],
    ]);
    expect(plan.milestones[0]?.id).toMatch(MISSION_MILESTONE_ID_RE);
    for (const feature of plan.milestones[0]?.features ?? []) {
      expect(feature.id).toMatch(MISSION_FEATURE_ID_RE);
      expect(feature.acceptanceCheckIds.length).toBeGreaterThan(0);
    }
    // Features are chained so the MVP scheduler runs them in order.
    expect(plan.milestones[0]?.features[1]?.dependsOn).toEqual([
      plan.milestones[0]?.features[0]?.id as string,
    ]);

    // Planning artifacts and vertical slices are filled even for a small goal.
    expect(plan.riskTier).toBe('low');
    expect(plan.riskReasons.length).toBeGreaterThan(0);
    expect(plan.productReview?.problem).toContain('Add a health endpoint');
    expect(plan.productReview?.desiredBehavior).toEqual([
      'Add a health endpoint',
      'Expose it on /health',
      'Document it in the README',
    ]);
    expect(plan.architecture?.summary.length).toBeGreaterThan(0);
    expect(plan.programDesign).toEqual({ modules: [], callGraph: [] });
    expect(plan.verticalSlices).toHaveLength(3);
    expect(plan.verticalSlices?.map((slice) => slice.featureIds.length)).toEqual([1, 1, 1]);
    for (const feature of plan.milestones[0]?.features ?? []) {
      expect(feature.riskTier).toBe('low');
      expect(feature.kind).toBe('slice');
      expect(feature.verticalSlice?.length).toBeGreaterThan(0);
    }
  });

  test('medium/high-risk goals require architecture and maintainability assertions', async () => {
    const plan = await deterministicMissionPlanner.plan({
      ...INPUT,
      title: 'Add authentication',
      goal: 'Add authentication\nSupport login\nDocument it',
    });

    expect(validateMissionPlan(plan).errors).toEqual([]);
    expect(plan.riskTier).toBe('high');
    expect(plan.riskReasons.join('; ')).toContain('auth');
    expect(plan.productReview).toBeDefined();
    expect(plan.architecture).toBeDefined();
    expect(plan.programDesign).toBeDefined();
    expect(plan.verticalSlices).toHaveLength(3);

    const assertions = plan.validationContract.assertions;
    expect(assertions).toHaveLength(5);
    const architecture = assertions.find((assertion) => assertion.tier === 'architecture');
    const maintainability = assertions.find((assertion) => assertion.tier === 'maintainability');
    expect(architecture?.id).toBe('VAL-ARCH');
    expect(architecture?.thresholds?.maxDependencyCycles).toBe(0);
    expect(maintainability?.id).toBe('VAL-MAINT');
    expect(maintainability?.thresholds?.maxDuplicationPercent).toBe(3);

    // Every feature claims the risk assertions so milestone scrutiny exercises them.
    for (const feature of plan.milestones[0]?.features ?? []) {
      expect(feature.acceptanceCheckIds).toContain('VAL-ARCH');
      expect(feature.acceptanceCheckIds).toContain('VAL-MAINT');
      expect(feature.kind).toBe('slice');
    }
  });

  test('falls back to a single feature when the goal has no non-empty lines', async () => {
    const plan = await deterministicMissionPlanner.plan({
      ...INPUT,
      goal: '\n   \n\t\n',
    });
    expect(validateMissionPlan(plan).errors).toEqual([]);
    expect(plan.milestones[0]?.features).toHaveLength(1);
    expect(plan.milestones[0]?.features[0]?.title).toBe(INPUT.title);
    expect(plan.validationContract.assertions).toHaveLength(1);
  });

  test('every assertion is required and has a tool and evidence', async () => {
    const plan = await deterministicMissionPlanner.plan(INPUT);
    for (const assertion of plan.validationContract.assertions) {
      expect(assertion.required).toBe(true);
      expect(assertion.tool.length).toBeGreaterThan(0);
      expect(assertion.evidence.length).toBeGreaterThan(0);
    }
  });

  test('the core schema accepts the planner output', async () => {
    const plan = await deterministicMissionPlanner.plan(INPUT);
    expect(validatePlannedMission(plan)).toEqual([]);
    expect(validateMissionPlan(asPlan(plan)).plan).not.toBeNull();
  });

  test('the OpenAI-compatible planner normalises ids and validates the plan', async () => {
    const raw = {
      title: 'Ship a health page',
      goal: 'Ship it',
      risks: ['scope'],
      assumptions: [],
      validationContract: {
        enforce: true,
        assertions: [
          {
            id: 'A1',
            title: 'Health page',
            assertion: 'The health page renders',
            tier: 'e2e',
            required: true,
            tool: 'agent-browser',
            evidence: 'screenshot',
          },
        ],
      },
      milestones: [
        {
          title: 'Milestone',
          description: 'One milestone',
          features: [
            {
              title: 'Add page',
              description: 'Add the page',
              dependsOn: [],
              acceptanceCheckIds: ['A1'],
            },
            {
              title: 'Link it',
              description: 'Link the page',
              dependsOn: [0],
              acceptanceCheckIds: ['A1', 'UNKNOWN'],
            },
          ],
        },
      ],
    };

    const planner = createOpenAIMissionPlanner({
      baseUrl: 'http://planner.invalid/v1',
      apiKey: 'test',
      model: 'test-model',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });

    const plan = await planner.plan(INPUT);
    expect(validateMissionPlan(plan).errors).toEqual([]);
    expect(plan.milestones[0]?.features[0]?.id).toMatch(MISSION_FEATURE_ID_RE);
    expect(plan.milestones[0]?.features[1]?.dependsOn).toEqual([
      plan.milestones[0]?.features[0]?.id as string,
    ]);
    // Unknown assertion ids are dropped; the first contract assertion is used.
    expect(plan.milestones[0]?.features[1]?.acceptanceCheckIds).toEqual(['A1']);
    expect(plan.riskTier).toBe('low');
    expect(plan.riskReasons.length).toBeGreaterThan(0);
    expect(plan.verticalSlices).toHaveLength(2);
    for (const feature of plan.milestones[0]?.features ?? []) {
      expect(feature.kind).toBe('slice');
      expect(feature.verticalSlice?.length).toBeGreaterThan(0);
      expect(feature.riskTier).toBe('low');
    }
  });

  test('normalises a medium-risk plan and synthesizes omitted artifacts', async () => {
    const raw = {
      title: 'Refactor billing',
      goal: 'Refactor billing',
      riskTier: 'medium',
      riskReasons: ['touches billing'],
      validationContract: {
        enforce: true,
        assertions: [
          {
            id: 'A1',
            title: 'Billing still works',
            assertion: 'The billing flow renders',
            tier: 'e2e',
            required: true,
            tool: 'agent-browser',
            evidence: 'screenshot',
            thresholds: { maxDuplicationPercent: 5 },
          },
        ],
      },
      milestones: [
        {
          title: 'Milestone',
          description: 'One milestone',
          features: [
            {
              title: 'Update billing page',
              description: 'Update the billing page',
              dependsOn: [],
              acceptanceCheckIds: ['A1'],
            },
          ],
        },
      ],
    };

    const planner = createOpenAIMissionPlanner({
      baseUrl: 'http://planner.invalid/v1',
      apiKey: 'test',
      model: 'test-model',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });

    const plan = await planner.plan(INPUT);
    expect(validateMissionPlan(plan).errors).toEqual([]);
    expect(plan.riskTier).toBe('medium');
    expect(plan.productReview).toBeDefined();
    expect(plan.architecture).toBeDefined();
    expect(plan.programDesign).toBeDefined();
    expect(plan.verticalSlices).toHaveLength(1);
    expect(plan.validationContract.assertions[0]?.thresholds).toEqual({
      maxDuplicationPercent: 5,
    });
    expect(
      plan.validationContract.assertions.some((assertion) => assertion.tier === 'architecture'),
    ).toBe(true);
    expect(
      plan.validationContract.assertions.some(
        (assertion) => assertion.tier === 'maintainability',
      ),
    ).toBe(true);
  });

  test('getMissionPlanner respects the test hook', async () => {
    const saved = {
      base: process.env.OPENAI_BASE_URL,
      key: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL,
      factoryModel: process.env.FACTORY_MODEL,
    };
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    delete process.env.FACTORY_MODEL;

    try {
      const scripted: MissionPlanner = {
        id: 'scripted',
        async plan() {
          return await deterministicMissionPlanner.plan(INPUT);
        },
      };
      setMissionPlanner(scripted);
      expect(getMissionPlanner().id).toBe('scripted');
      setMissionPlanner(null);
      expect(getMissionPlanner()).toBe(deterministicMissionPlanner);
    } finally {
      for (const [name, value] of [
        ['OPENAI_BASE_URL', saved.base],
        ['OPENAI_API_KEY', saved.key],
        ['OPENAI_MODEL', saved.model],
        ['FACTORY_MODEL', saved.factoryModel],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
