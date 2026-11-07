import { describe, expect, test } from 'bun:test';
import {
  missionAssertionsForMilestone,
  missionBudgetExceededData,
  missionFeatureById,
  missionFeatureOrder,
  missionMilestoneForFeature,
  missionMilestoneProgress,
  nextRunnableMissionFeature,
} from '../src/mission-plan';
import type { MissionPlanData } from '../src/types';

function plan(): MissionPlanData {
  return {
    version: 'v1alpha1',
    missionId: 'mis_01M6QCY01B28JHAMTGNHZRHRRR',
    factory: 'example',
    definitionCommit: 'a1b2c3d4',
    title: 'Mission',
    goal: 'Goal',
    createdAt: '2026-11-06T00:00:00.000Z',
    validationContract: {
      version: 'v1alpha1',
      missionId: 'mis_01M6QCY01B28JHAMTGNHZRHRRR',
      factory: 'example',
      definitionCommit: 'a1b2c3d4',
      createdAt: '2026-11-06T00:00:00.000Z',
      enforce: true,
      assertions: [
        {
          id: 'VAL-1',
          title: 'One',
          assertion: 'One',
          tier: 'e2e',
          required: true,
          tool: 'playwright',
          evidence: 'screenshot',
        },
      ],
      risks: [],
      source: 'orchestrator',
    },
    milestones: [
      {
        id: 'mst_01M6QCY01B28JHAMTGNHZRHRRR',
        title: 'M1',
        description: 'M1',
        order: 0,
        features: [
          {
            id: 'mft_01M6QCY01B28JHAMTGNHZRHRRR',
            title: 'F1',
            description: 'F1',
            order: 0,
            dependsOn: [],
            acceptanceCheckIds: ['VAL-1'],
          },
          {
            id: 'mft_01M6QCY01B28JHAMTGNHZRHRR2',
            title: 'F2',
            description: 'F2',
            order: 1,
            dependsOn: ['mft_01M6QCY01B28JHAMTGNHZRHRRR'],
            acceptanceCheckIds: ['VAL-1'],
          },
        ],
      },
    ],
    risks: [],
    assumptions: [],
  };
}

describe('mission plan helpers', () => {
  test('orders features by dependencies', () => {
    expect(missionFeatureOrder(plan()).map((feature) => feature.title)).toEqual(['F1', 'F2']);
  });

  test('returns the next runnable feature', () => {
    expect(nextRunnableMissionFeature(plan(), {})?.feature.title).toBe('F1');
    expect(
      nextRunnableMissionFeature(plan(), {
        mft_01M6QCY01B28JHAMTGNHZRHRRR: 'done',
      })?.feature.title,
    ).toBe('F2');
    expect(
      nextRunnableMissionFeature(plan(), {
        mft_01M6QCY01B28JHAMTGNHZRHRRR: 'done',
        mft_01M6QCY01B28JHAMTGNHZRHRR2: 'done',
      }),
    ).toBeNull();
  });

  test('rejects a dependency cycle', () => {
    const invalid = plan();
    invalid.milestones[0]!.features[0]!.dependsOn = [
      invalid.milestones[0]!.features[1]!.id,
    ];
    expect(() => missionFeatureOrder(invalid)).toThrow('cycle');
  });

  test('resolves assertions, features and milestones by id', () => {
    const valid = plan();
    expect(missionAssertionsForMilestone(valid, valid.milestones[0]!.id)).toEqual(['VAL-1']);
    expect(missionFeatureById(valid, valid.milestones[0]!.features[1]!.id)?.title).toBe('F2');
    expect(missionMilestoneForFeature(valid, valid.milestones[0]!.features[1]!.id)?.title).toBe(
      'M1',
    );
    expect(missionFeatureById(valid, 'mft_00000000000000000000000000')).toBeNull();
  });

  test('milestone progress counts done, failed and running', () => {
    const valid = plan();
    const milestone = valid.milestones[0]!;
    expect(missionMilestoneProgress(milestone, {})).toEqual({
      total: 2,
      done: 0,
      failed: 0,
      running: 0,
    });
    expect(
      missionMilestoneProgress(milestone, {
        [milestone.features[0]!.id]: 'done',
        [milestone.features[1]!.id]: 'running',
      }),
    ).toEqual({ total: 2, done: 1, failed: 0, running: 1 });
  });

  test('budget caps', () => {
    expect(
      missionBudgetExceededData({ maxCostUsd: 1 }, { costUsd: 1, runs: 1, startedAt: null }),
    ).toContain('maxCostUsd');
    expect(
      missionBudgetExceededData({ maxRuns: 1 }, { costUsd: 0, runs: 1, startedAt: null }),
    ).toContain('maxRuns');
    expect(
      missionBudgetExceededData(
        { maxWallClockHours: 1 },
        {
          costUsd: 0,
          runs: 0,
          startedAt: '2026-11-06T00:00:00.000Z',
          now: new Date('2026-11-06T02:00:00.000Z'),
        },
      ),
    ).toContain('maxWallClockHours');
  });
});
