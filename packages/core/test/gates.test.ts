import { describe, expect, it } from 'bun:test';
import {
  automationFrontmatterSchema,
  factorySchema,
  loadOrThrow,
  resolveAllGates,
  resolveGate,
  type AutomationDef,
  type FactoryManifest,
  type Gate,
} from '../src/index';
import { EXAMPLE, LIGHTS_OFF } from './helpers';

function factory(gates: Record<string, string>, mergePolicy = 'human'): FactoryManifest {
  return factorySchema.parse({
    schemaVersion: 'v1alpha1',
    name: 'fixture',
    repositories: [{ owner: 'acme', name: 'api' }],
    agentDefaults: { model: 'test-model' },
    gates,
    mergePolicy,
  });
}

function automation(gates?: Record<string, string>): AutomationDef {
  return automationFrontmatterSchema.parse({
    triggers: [{ provider: 'github', event: 'issue_labeled' }],
    ...(gates ? { gates } : {}),
  });
}

describe('gate precedence (automation -> factory -> global)', () => {
  const cases: Array<{
    name: string;
    factoryGates: Record<string, string>;
    automationGates?: Record<string, string>;
    globalDefault: Gate;
    expected: Gate;
    source: 'automation' | 'factory' | 'global';
  }> = [
    {
      name: 'automation override wins over factory',
      factoryGates: { review: 'human' },
      automationGates: { review: 'agent' },
      globalDefault: 'human',
      expected: 'agent',
      source: 'automation',
    },
    {
      name: 'automation policy wins over factory',
      factoryGates: { review: 'agent' },
      automationGates: { review: 'policy:security-review' },
      globalDefault: 'human',
      expected: 'policy:security-review',
      source: 'automation',
    },
    {
      name: 'factory wins over global default',
      factoryGates: { review: 'agent' },
      globalDefault: 'human',
      expected: 'agent',
      source: 'factory',
    },
    {
      name: 'factory wins when the automation overrides a different stage',
      factoryGates: { review: 'human' },
      automationGates: { spec: 'agent' },
      globalDefault: 'agent',
      expected: 'human',
      source: 'factory',
    },
    {
      name: 'global default applies when nothing else is set',
      factoryGates: {},
      globalDefault: 'agent',
      expected: 'agent',
      source: 'global',
    },
    {
      name: 'global default of human applies when nothing else is set',
      factoryGates: {},
      globalDefault: 'human',
      expected: 'human',
      source: 'global',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const resolved = resolveGate(
        'review',
        testCase.automationGates ? automation(testCase.automationGates) : null,
        factory(testCase.factoryGates),
        testCase.globalDefault,
      );
      expect(resolved).toEqual({
        stage: 'review',
        gate: testCase.expected,
        source: testCase.source,
      });
    });
  }

  it('throws on an invalid gate value that bypassed schema validation', () => {
    const broken = { ...factory({}), gates: { review: 'robot' } } as unknown as FactoryManifest;
    expect(() => resolveGate('review', null, broken)).toThrow(/invalid gate/);
  });

  it('rejects invalid gate values in the schema', () => {
    expect(() => factory({ review: 'robot' })).toThrow();
  });
});

describe('gate resolution over all stages', () => {
  it('reports the reference factory as lights-on', () => {
    const resolution = resolveAllGates(loadOrThrow(EXAMPLE).manifest);
    expect(resolution.fullyAutonomous).toBe(false);
    expect(resolution.benchmarkGateRequired).toBe(false);
    expect(resolution.stages.spec).toEqual({ stage: 'spec', gate: 'human', source: 'factory' });
    expect(resolution.stages.implement).toEqual({
      stage: 'implement',
      gate: 'agent',
      source: 'factory',
    });
  });

  it('reports lights-off as fully autonomous and benchmark-gated', () => {
    const resolution = resolveAllGates(loadOrThrow(LIGHTS_OFF).manifest);
    expect(resolution.mergePolicy).toBe('auto_on_green');
    expect(resolution.fullyAutonomous).toBe(true);
    expect(resolution.benchmarkGateRequired).toBe(true);
    for (const stage of Object.values(resolution.stages)) {
      expect(stage.gate).toBe('agent');
    }
  });

  it('does not claim autonomy when a single stage still needs a human', () => {
    const resolution = resolveAllGates(factory({ spec: 'human' }, 'auto_on_green'));
    expect(resolution.fullyAutonomous).toBe(false);
    expect(resolution.benchmarkGateRequired).toBe(false);
  });

  it('does not claim autonomy without an auto merge policy', () => {
    const gates = Object.fromEntries(
      ['spec', 'plan', 'implement', 'review', 'pr_review', 'deploy'].map((stage) => [stage, 'agent']),
    );
    expect(resolveAllGates(factory(gates, 'human')).fullyAutonomous).toBe(false);
    expect(resolveAllGates(factory(gates, 'auto_after_n_approvals')).fullyAutonomous).toBe(true);
  });

  it('applies a global default to stages the factory does not declare', () => {
    const resolution = resolveAllGates(factory({}), { globalDefault: 'agent' });
    expect(resolution.stages.deploy.source).toBe('global');
    expect(resolution.stages.deploy.gate).toBe('agent');
  });

  it('applies automation overrides when resolving all stages', () => {
    const resolution = resolveAllGates(factory({ review: 'human' }), {
      automation: automation({ review: 'agent' }),
    });
    expect(resolution.stages.review).toEqual({
      stage: 'review',
      gate: 'agent',
      source: 'automation',
    });
  });
});
