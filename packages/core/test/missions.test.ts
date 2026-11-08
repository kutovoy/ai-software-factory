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
    riskTier: 'low',
    riskReasons: [],
    ...overrides,
  };
}

function mediumRiskPlan(): MissionPlan {
  const base = plan({ riskTier: 'medium', riskReasons: ['goal touches billing'] });
  base.validationContract.assertions.push(
    {
      id: 'VAL-ARCH-001',
      title: 'Architecture boundaries',
      assertion: 'No dependency cycles or layering violations',
      tier: 'architecture',
      required: true,
      tool: 'command',
      evidence: 'exit code 0',
    },
    {
      id: 'VAL-MAINT-001',
      title: 'Maintainability thresholds',
      assertion: 'Duplication stays below the threshold',
      tier: 'maintainability',
      required: true,
      tool: 'command',
      evidence: 'metrics report',
      thresholds: { maxDuplicationPercent: 3 },
    },
  );
  base.productReview = {
    problem: 'Billing export is missing',
    desiredBehavior: ['The export downloads a CSV'],
    mockups: [],
  };
  base.architecture = {
    summary: 'A small export service behind the existing billing module',
    components: [
      { name: 'ExportService', responsibility: 'Builds the CSV', contracts: ['exportCsv()'] },
    ],
    dataModels: ['Invoice'],
    constraints: ['No new runtime dependencies'],
  };
  base.programDesign = {
    modules: [
      {
        name: 'ExportService',
        path: 'src/billing/export.ts',
        responsibility: 'Builds the CSV',
        publicApi: ['exportCsv'],
      },
    ],
    callGraph: ['route -> ExportService'],
  };
  const [featureA, featureB] = base.milestones[0]!.features;
  featureA!.kind = 'slice';
  featureA!.verticalSlice = 'The page renders and the export link works';
  featureB!.kind = 'slice';
  featureB!.verticalSlice = 'The link downloads the CSV';
  base.verticalSlices = [
    {
      name: 'Billing export',
      order: 0,
      featureIds: [featureA!.id, featureB!.id],
      checks: ['page renders', 'CSV downloads'],
    },
  ];
  return base;
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

describe('mission risk tiers and planning artifacts', () => {
  it('keeps an old low-risk plan without new artifacts valid', () => {
    const result = validateMissionPlan(plan());
    expect(result.errors).toEqual([]);
    expect(result.plan?.riskTier).toBe('low');
    expect(result.plan?.riskReasons).toEqual([]);
    expect(result.plan?.productReview).toBeUndefined();
  });

  it('requires product review, architecture, program design, slices and quality assertions for medium risk', () => {
    const result = validateMissionPlan(plan({ riskTier: 'medium' }));
    expect(result.plan).toBeNull();
    const errors = result.errors.join(' ');
    expect(errors).toContain('productReview');
    expect(errors).toContain('architecture section');
    expect(errors).toContain('programDesign');
    expect(errors).toContain('verticalSlices');
    expect(errors).toContain('architecture assertion');
    expect(errors).toContain('maintainability assertion');
  });

  it('applies the same artifact requirements to high risk', () => {
    const missing = validateMissionPlan(plan({ riskTier: 'high' }));
    expect(missing.plan).toBeNull();
    expect(missing.errors.join(' ')).toContain('productReview');

    const complete = mediumRiskPlan();
    complete.riskTier = 'high';
    complete.riskReasons = ['goal mentions "security"'];
    expect(validateMissionPlan(complete).errors).toEqual([]);
  });

  it('accepts a complete medium-risk plan', () => {
    const result = validateMissionPlan(mediumRiskPlan());
    expect(result.errors).toEqual([]);
    expect(result.plan?.riskTier).toBe('medium');
    expect(result.plan?.verticalSlices?.[0]?.featureIds).toHaveLength(2);
    expect(
      result.plan?.validationContract.assertions.find((item) => item.id === 'VAL-MAINT-001')
        ?.thresholds,
    ).toEqual({ maxDuplicationPercent: 3 });
  });

  it('requires at least one non-enabler feature when slices are present', () => {
    const invalid = mediumRiskPlan();
    for (const feature of invalid.milestones[0]!.features) feature.kind = 'enabler';
    const result = validateMissionPlan(invalid);
    expect(result.plan).toBeNull();
    expect(result.errors.join(' ')).toContain('kind "slice"');
  });

  it('requires enablers to state what later slice verifies them', () => {
    const invalid = mediumRiskPlan();
    const enabler = invalid.milestones[0]!.features[0]!;
    enabler.kind = 'enabler';
    delete enabler.verticalSlice;
    const result = validateMissionPlan(invalid);
    expect(result.plan).toBeNull();
    expect(result.errors.join(' ')).toContain('enabler feature');
    expect(result.errors.join(' ')).toContain('verticalSlice');
  });

  it('rejects unknown, duplicated and uncovered features in vertical slices', () => {
    const invalid = mediumRiskPlan();
    const [featureA, featureB] = invalid.milestones[0]!.features;
    invalid.verticalSlices = [
      { name: 'First', order: 0, featureIds: [featureA!.id, featureA!.id], checks: [] },
      { name: 'Second', order: 1, featureIds: ['mft_00000000000000000000000000'], checks: [] },
    ];

    const result = validateMissionPlan(invalid);
    expect(result.plan).toBeNull();
    const errors = result.errors.join(' ');
    expect(errors).toContain('appears in more than one vertical slice');
    expect(errors).toContain('unknown feature');
    expect(errors).toContain(`feature "${featureB!.id}" is not part of any vertical slice`);
  });

  it('applies slice coverage rules when a low-risk plan declares slices', () => {
    const invalid = plan();
    const [featureA] = invalid.milestones[0]!.features;
    invalid.verticalSlices = [
      { name: 'Only A', order: 0, featureIds: [featureA!.id], checks: [] },
    ];
    const result = validateMissionPlan(invalid);
    expect(result.plan).toBeNull();
    expect(result.errors.join(' ')).toContain('not part of any vertical slice');
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
