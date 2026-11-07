import { describe, expect, it } from 'bun:test';
import {
  missionBudgetExceeded,
  newMissionFeatureId,
  newMissionId,
  newMissionMilestoneId,
  nextRunnableFeature,
  validateMissionPlan,
  type MissionPlan,
} from '../src/index';

function plan(overrides: Partial<MissionPlan> = {}): MissionPlan {
  const missionId = newMissionId(1_700_000_000_000);
  const milestoneId = newMissionMilestoneId(1_700_000_000_001);
  const featureA = newMissionFeatureId(1_700_000_000_002);
  const featureB = newMissionFeatureId(1_700_000_000_003);
  return {
    version: 'v1alpha1',
    missionId,
    factory: 'example',
    definitionCommit: 'a1b2c3d4',
    title: 'Build a small app',
    goal: 'Add a page and verify it',
    createdAt: '2026-11-06T00:00:00.000Z',
    validationContract: {
      version: 'v1alpha1',
      missionId,
      factory: 'example',
      definitionCommit: 'a1b2c3d4',
      createdAt: '2026-11-06T00:00:00.000Z',
      enforce: true,
      assertions: [
        {
          id: 'VAL-PAGE-001',
          title: 'Page renders',
          assertion: 'The page renders the expected heading',
          tier: 'e2e',
          required: true,
          tool: 'agent-browser',
          evidence: 'screenshot',
        },
      ],
      risks: [],
      source: 'orchestrator',
    },
    milestones: [
      {
        id: milestoneId,
        title: 'Foundation',
        description: 'The first page',
        order: 0,
        features: [
          {
            id: featureA,
            title: 'Add page',
            description: 'Create the page',
            order: 0,
            dependsOn: [],
            acceptanceCheckIds: ['VAL-PAGE-001'],
          },
          {
            id: featureB,
            title: 'Add link',
            description: 'Link to the page',
            order: 1,
            dependsOn: [featureA],
            acceptanceCheckIds: ['VAL-PAGE-001'],
          },
        ],
      },
    ],
    risks: [],
    assumptions: [],
    ...overrides,
  };
}

describe('mission plan validation', () => {
  it('accepts a valid plan and returns the parsed plan', () => {
    const result = validateMissionPlan(plan());
    expect(result.errors).toEqual([]);
    expect(result.plan?.milestones[0]?.features).toHaveLength(2);
  });

  it('rejects an unknown dependency', () => {
    const invalid = plan();
    invalid.milestones[0]!.features[1]!.dependsOn = ['mft_00000000000000000000000000'];
    const result = validateMissionPlan(invalid);
    expect(result.plan).toBeNull();
    expect(result.errors.join(' ')).toContain('unknown feature');
  });

  it('rejects a dependency cycle', () => {
    const invalid = plan();
    invalid.milestones[0]!.features[0]!.dependsOn = [
      invalid.milestones[0]!.features[1]!.id,
    ];
    const result = validateMissionPlan(invalid);
    expect(result.plan).toBeNull();
    expect(result.errors.join(' ')).toContain('cycle');
  });

  it('rejects a feature that claims an unknown assertion', () => {
    const invalid = plan();
    invalid.milestones[0]!.features[0]!.acceptanceCheckIds = ['VAL-MISSING'];
    const result = validateMissionPlan(invalid);
    expect(result.plan).toBeNull();
    expect(result.errors.join(' ')).toContain('unknown assertion');
  });
});

describe('mission scheduling', () => {
  it('returns the first runnable feature in dependency order', () => {
    const valid = plan();
    const [featureA, featureB] = valid.milestones[0]!.features;
    expect(nextRunnableFeature(valid, {})?.feature.id).toBe(featureA!.id);
    expect(
      nextRunnableFeature(valid, {
        [featureA!.id]: 'done',
      })?.feature.id,
    ).toBe(featureB!.id);
    expect(
      nextRunnableFeature(valid, {
        [featureA!.id]: 'done',
        [featureB!.id]: 'done',
      }),
    ).toBeNull();
  });

  it('does not run a feature while a dependency is failed', () => {
    const valid = plan();
    const [featureA, featureB] = valid.milestones[0]!.features;
    expect(
      nextRunnableFeature(valid, {
        [featureA!.id]: 'failed',
      })?.feature.id,
    ).not.toBe(featureB!.id);
  });
});

describe('mission budget', () => {
  it('reports spend, run and wall-clock caps', () => {
    expect(
      missionBudgetExceeded({ maxCostUsd: 10 }, { costUsd: 10, runs: 2, startedAt: null }),
    ).toContain('maxCostUsd');
    expect(
      missionBudgetExceeded({ maxRuns: 2 }, { costUsd: 0, runs: 2, startedAt: null }),
    ).toContain('maxRuns');
    expect(
      missionBudgetExceeded(
        { maxWallClockHours: 1 },
        { costUsd: 0, runs: 0, startedAt: '2026-11-06T00:00:00.000Z', now: new Date('2026-11-06T02:00:00.000Z') },
      ),
    ).toContain('maxWallClockHours');
    expect(missionBudgetExceeded({ maxCostUsd: 10 }, { costUsd: 1, runs: 1, startedAt: null })).toBeNull();
  });
});
