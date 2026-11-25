import { describe, expect, it } from 'bun:test';
import {
  EXPERIMENT_PROVIDERS,
  experimentsConfigSchema,
  factorySchema,
  missionExperimentSchema,
  missionPlanSchema,
  newMissionFeatureId,
  newMissionId,
  newMissionMilestoneId,
  validateMissionPlan,
  type MissionPlan,
} from '../src/index';

function factory(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'v1alpha1',
    name: 'experiment-demo',
    repositories: [{ owner: 'acme', name: 'api' }],
    agentDefaults: { model: 'test-model' },
    gates: { review: 'human' },
    mergePolicy: 'human',
    ...extra,
  };
}

function plan(overrides: Partial<MissionPlan> = {}): MissionPlan {
  const missionId = newMissionId(1_700_000_000_000);
  const milestoneId = newMissionMilestoneId(1_700_000_000_001);
  const featureId = newMissionFeatureId(1_700_000_000_002);
  return {
    version: 'v1alpha1',
    missionId,
    factory: 'example',
    definitionCommit: 'a1b2c3d4',
    title: 'Run an experiment',
    goal: 'Ship a flag and measure it',
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
          id: 'VAL-FLAG-001',
          title: 'Flag resolves',
          assertion: 'The experiment flag resolves to the control variant by default',
          tier: 'e2e',
          required: true,
          tool: 'command',
          evidence: 'exit code 0',
        },
      ],
      risks: [],
      source: 'orchestrator',
    },
    milestones: [
      {
        id: milestoneId,
        title: 'Rollout',
        description: 'One feature',
        order: 0,
        features: [
          {
            id: featureId,
            title: 'Add flag',
            description: 'Introduce the flag',
            order: 0,
            dependsOn: [],
            acceptanceCheckIds: ['VAL-FLAG-001'],
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

describe('experiments config', () => {
  it('exposes the supported providers', () => {
    expect(EXPERIMENT_PROVIDERS).toEqual(['posthog', 'statsig', 'launchdarkly', 'generic']);
  });

  it('defaults the flag prefix and cleanup requirement', () => {
    const parsed = experimentsConfigSchema.parse({ provider: 'posthog' });
    expect(parsed).toEqual({
      provider: 'posthog',
      flagPrefix: 'factory_',
      requireCleanup: true,
    });
  });

  it('accepts a secret name reference and explicit overrides', () => {
    const parsed = experimentsConfigSchema.parse({
      provider: 'statsig',
      projectKeySecret: 'STATSIG_KEY',
      flagPrefix: 'demo_',
      requireCleanup: false,
    });
    expect(parsed.projectKeySecret).toBe('STATSIG_KEY');
    expect(parsed.flagPrefix).toBe('demo_');
    expect(parsed.requireCleanup).toBe(false);
  });

  it('rejects unknown providers, inline secrets and unknown fields', () => {
    expect(experimentsConfigSchema.safeParse({ provider: 'split' }).success).toBe(false);
    expect(
      experimentsConfigSchema.safeParse({
        provider: 'generic',
        projectKeySecret: 'sk-live-inline-key',
      }).success,
    ).toBe(false);
    expect(
      experimentsConfigSchema.safeParse({ provider: 'generic', projectKey: 'inline' }).success,
    ).toBe(false);
  });

  it('validates on the factory without breaking old definitions', () => {
    expect(factorySchema.safeParse(factory()).success).toBe(true);
    const parsed = factorySchema.safeParse(
      factory({ experiments: { provider: 'launchdarkly', projectKeySecret: 'LD_KEY' } }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.experiments?.provider).toBe('launchdarkly');
      expect(parsed.data.experiments?.flagPrefix).toBe('factory_');
    }
    expect(factorySchema.safeParse(factory({ experiments: { provider: 'nope' } })).success).toBe(
      false,
    );
  });
});

describe('mission experiment metadata', () => {
  it('keeps old plans valid without an experiment', () => {
    expect(missionPlanSchema.safeParse(plan()).success).toBe(true);
    expect(validateMissionPlan(plan()).errors).toEqual([]);
  });

  it('accepts a full experiment record', () => {
    const withExperiment = plan({
      experiment: {
        flag: 'factory_checkout_v2',
        successMetric: 'checkout conversion rate',
        guardrail: 'payment error rate must not increase',
        cleanupAfterDays: 30,
      },
    });
    const parsed = missionPlanSchema.safeParse(withExperiment);
    expect(parsed.success).toBe(true);
    expect(validateMissionPlan(withExperiment).errors).toEqual([]);
  });

  it('requires a flag and a success metric', () => {
    expect(missionExperimentSchema.safeParse({ successMetric: 'conversion' }).success).toBe(false);
    expect(missionExperimentSchema.safeParse({ flag: 'x' }).success).toBe(false);
  });

  it('rejects unknown experiment fields and out-of-range cleanup windows', () => {
    expect(
      missionPlanSchema.safeParse(
        plan({
          experiment: {
            flag: 'f',
            successMetric: 'm',
            rollout: 'gradual',
          } as unknown as MissionPlan['experiment'],
        }),
      ).success,
    ).toBe(false);
    expect(
      missionPlanSchema.safeParse(
        plan({ experiment: { flag: 'f', successMetric: 'm', cleanupAfterDays: 500 } }),
      ).success,
    ).toBe(false);
  });
});
