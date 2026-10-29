import { describe, expect, it } from 'bun:test';
import { factorySchema, mapZodIssues, resolveImprovement } from '../src/index';

function baseFactory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'v1alpha1',
    name: 'fixture',
    repositories: [{ owner: 'acme', name: 'api' }],
    agentDefaults: { model: 'test-model' },
    gates: { review: 'human' },
    mergePolicy: 'human',
    ...overrides,
  };
}

function issues(value: unknown) {
  const result = factorySchema.safeParse(value);
  return result.success ? [] : mapZodIssues(result.error.issues, 'factory.yaml');
}

describe('improvement block', () => {
  it('defaults to propose_only when the block is omitted', () => {
    const resolved = resolveImprovement(undefined);
    expect(resolved.authority).toBe('propose_only');
    expect(resolved.source).toBe('default');
    expect(resolved.maxProbes).toBe(3);
    expect(resolved.observationWindowHours).toBe(24);
    expect(resolved.canaryAvailable).toBe(true);
  });

  it('accepts every supported authority', () => {
    for (const authority of ['propose_only', 'auto_merge_on_benchmark']) {
      expect(issues(baseFactory({ improvement: { authority } }))).toEqual([]);
    }
    expect(
      issues(
        baseFactory({
          improvement: { authority: 'canary', canaryPercent: 10, rollbackThreshold: 0.1 },
        }),
      ),
    ).toEqual([]);
  });

  it('rejects an unsupported authority with invalid_value', () => {
    const errors = issues(baseFactory({ improvement: { authority: 'auto_everything' } }));
    expect(errors.map((error) => error.code)).toContain('invalid_value');
    expect(errors.some((error) => error.pointer === '/improvement/authority')).toBe(true);
  });

  it('requires canaryPercent and rollbackThreshold for canary', () => {
    const errors = issues(baseFactory({ improvement: { authority: 'canary' } }));
    expect(errors.map((error) => error.code).filter((code) => code === 'missing_field')).toHaveLength(2);
    expect(errors.map((error) => error.pointer)).toContain('/improvement/canaryPercent');
    expect(errors.map((error) => error.pointer)).toContain('/improvement/rollbackThreshold');
  });

  it('rejects an out-of-range canaryPercent', () => {
    const errors = issues(
      baseFactory({
        improvement: { authority: 'canary', canaryPercent: 0, rollbackThreshold: 0.1 },
      }),
    );
    expect(errors.map((error) => error.code)).toContain('invalid_value');
    expect(errors.some((error) => error.pointer === '/improvement/canaryPercent')).toBe(true);
  });

  it('rejects unknown fields inside the block', () => {
    const errors = issues(baseFactory({ improvement: { authority: 'propose_only', nope: 1 } }));
    expect(errors.map((error) => error.code)).toContain('unknown_field');
  });

  it('resolves a declared block and reports the source explicitly', () => {
    const parsed = factorySchema.parse(
      baseFactory({
        improvement: { authority: 'canary', canaryPercent: 25, rollbackThreshold: 0.2 },
      }),
    );
    const resolved = resolveImprovement(parsed.improvement);
    expect(resolved).toMatchObject({
      authority: 'canary',
      canaryPercent: 25,
      rollbackThreshold: 0.2,
      observationWindowHours: 24,
      maxProbes: 3,
      source: 'declared',
    });
  });
});
