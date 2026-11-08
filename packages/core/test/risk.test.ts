import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_RISK_GOVERNANCE,
  RISK_TIERS,
  classifyRisk,
  factorySchema,
  pathMatchesHighRisk,
  resolveRiskGovernance,
  riskPolicyFor,
  riskTierRank,
} from '../src/index';

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

describe('risk governance defaults', () => {
  test('ships low/medium/high policies with low as the default tier', () => {
    expect(RISK_TIERS).toEqual(['low', 'medium', 'high']);
    expect(DEFAULT_RISK_GOVERNANCE.defaultTier).toBe('low');
    expect(DEFAULT_RISK_GOVERNANCE.highRiskPaths).toEqual([]);
    expect(DEFAULT_RISK_GOVERNANCE.tiers.low).toEqual({
      planApproval: 'auto',
      review: 'agent',
      merge: 'auto_on_green',
    });
    expect(DEFAULT_RISK_GOVERNANCE.tiers.medium).toEqual({
      planApproval: 'human',
      review: 'agent',
      merge: 'auto_on_green',
    });
    expect(DEFAULT_RISK_GOVERNANCE.tiers.high).toEqual({
      planApproval: 'human',
      review: 'human',
      merge: 'human',
    });
  });

  test('resolves undefined and null to the defaults', () => {
    expect(resolveRiskGovernance(undefined)).toEqual(DEFAULT_RISK_GOVERNANCE);
    expect(resolveRiskGovernance(null)).toEqual(DEFAULT_RISK_GOVERNANCE);
  });

  test('merges partial tiers and filters invalid high-risk paths', () => {
    const resolved = resolveRiskGovernance({
      defaultTier: 'high',
      tiers: { high: { merge: 'disabled' }, low: { review: 'human' } },
      highRiskPaths: ['auth/**', '', 42, 'billing/**'],
    });

    expect(resolved.defaultTier).toBe('high');
    expect(resolved.tiers.high).toEqual({
      planApproval: 'human',
      review: 'human',
      merge: 'disabled',
    });
    expect(resolved.tiers.low).toEqual({
      planApproval: 'auto',
      review: 'human',
      merge: 'auto_on_green',
    });
    expect(resolved.tiers.medium).toEqual(DEFAULT_RISK_GOVERNANCE.tiers.medium);
    expect(resolved.highRiskPaths).toEqual(['auth/**', 'billing/**']);
    expect(DEFAULT_RISK_GOVERNANCE.tiers.high.merge).toBe('human');
  });

  test('falls back on invalid enum values', () => {
    const resolved = resolveRiskGovernance({
      defaultTier: 'critical',
      tiers: { low: { planApproval: 'robot', review: 'committee', merge: 'yolo' } },
    });
    expect(resolved.defaultTier).toBe('low');
    expect(resolved.tiers.low).toEqual(DEFAULT_RISK_GOVERNANCE.tiers.low);
  });

  test('returns the tier policy and ranks tiers', () => {
    expect(riskPolicyFor(null, 'high')).toEqual(DEFAULT_RISK_GOVERNANCE.tiers.high);
    const governance = resolveRiskGovernance({ tiers: { low: { merge: 'human' } } });
    expect(riskPolicyFor(governance, 'low').merge).toBe('human');
    expect(riskTierRank('low')).toBeLessThan(riskTierRank('medium'));
    expect(riskTierRank('medium')).toBeLessThan(riskTierRank('high'));
  });
});

describe('high-risk path matching', () => {
  test('matches directory globs case-insensitively', () => {
    expect(pathMatchesHighRisk('auth/**', 'auth/login.ts')).toBe(true);
    expect(pathMatchesHighRisk('AUTH/**', 'auth/login.ts')).toBe(true);
    expect(pathMatchesHighRisk('auth/**', 'src/auth/login.ts')).toBe(false);
    expect(pathMatchesHighRisk('**/auth/**', 'src/auth/login.ts')).toBe(true);
    expect(pathMatchesHighRisk('**/auth/**', 'auth/login.ts')).toBe(true);
  });

  test('supports **, * and ? without crossing directory separators', () => {
    expect(pathMatchesHighRisk('**/*.ts', 'src/a/b.ts')).toBe(true);
    expect(pathMatchesHighRisk('**/*.ts', 'a.ts')).toBe(true);
    expect(pathMatchesHighRisk('**/*.ts', 'a.js')).toBe(false);
    expect(pathMatchesHighRisk('*.ts', 'src/a.ts')).toBe(false);
    expect(pathMatchesHighRisk('src/*/test/*.ts', 'src/x/test/a.ts')).toBe(true);
    expect(pathMatchesHighRisk('src/*/test/*.ts', 'src/x/y/test/a.ts')).toBe(false);
    expect(pathMatchesHighRisk('src/?.ts', 'src/a.ts')).toBe(true);
    expect(pathMatchesHighRisk('src/?.ts', 'src/ab.ts')).toBe(false);
  });

  test('rejects empty patterns and paths', () => {
    expect(pathMatchesHighRisk('', 'auth/login.ts')).toBe(false);
    expect(pathMatchesHighRisk('auth/**', '')).toBe(false);
  });
});

describe('risk classification', () => {
  test('defaults to low with an explanatory reason', () => {
    const result = classifyRisk({});
    expect(result.tier).toBe('low');
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons[0]).toContain('low');
  });

  test('takes the highest of the declared and governance default tiers', () => {
    expect(classifyRisk({ declaredTier: 'high' }).tier).toBe('high');
    expect(
      classifyRisk({ governance: resolveRiskGovernance({ defaultTier: 'medium' }) }).tier,
    ).toBe('medium');
    expect(
      classifyRisk({
        declaredTier: 'low',
        governance: resolveRiskGovernance({ defaultTier: 'medium' }),
      }).tier,
    ).toBe('medium');
  });

  test('classifies high-risk paths as high', () => {
    const governance = resolveRiskGovernance({
      highRiskPaths: ['auth/**', 'billing/**', 'migrations/**'],
    });
    const result = classifyRisk({ paths: ['src/page.ts', 'auth/login.ts'], governance });
    expect(result.tier).toBe('high');
    expect(result.reasons.join(' ')).toContain('auth/login.ts');
    expect(result.reasons.join(' ')).toContain('auth/**');
  });

  test('classifies change size at the thresholds', () => {
    expect(classifyRisk({ changeSize: 149 }).tier).toBe('low');
    expect(classifyRisk({ changeSize: 150 }).tier).toBe('medium');
    expect(classifyRisk({ changeSize: 399 }).tier).toBe('medium');
    expect(classifyRisk({ changeSize: 400 }).tier).toBe('high');
    expect(classifyRisk({ changeSize: Number.NaN }).tier).toBe('low');
  });

  test('classifies sensitive goals as high', () => {
    for (const goal of [
      'Add authentication to the console',
      'Change the billing invoice format',
      'Add a payment retry flow',
      'Run a database migration',
      'Expose a public API endpoint',
      'Fix a security bug',
    ]) {
      expect(classifyRisk({ goal }).tier).toBe('high');
    }
  });

  test('does not over-match words containing a keyword prefix', () => {
    expect(classifyRisk({ goal: 'Update the author page' }).tier).toBe('low');
  });

  test('classifies goals with more than four non-empty lines as medium', () => {
    const goal = ['one', 'two', 'three', 'four', 'five'].join('\n');
    expect(classifyRisk({ goal }).tier).toBe('medium');
    expect(classifyRisk({ goal: ['one', '', 'two', 'three', 'four'].join('\n') }).tier).toBe(
      'low',
    );
  });

  test('reports every contributing reason deterministically', () => {
    const governance = resolveRiskGovernance({ highRiskPaths: ['auth/**'] });
    const result = classifyRisk({
      declaredTier: 'medium',
      paths: ['auth/login.ts'],
      changeSize: 420,
      goal: 'Add authentication\nand a migration',
      governance,
    });
    expect(result.tier).toBe('high');
    expect(result.reasons).toEqual([
      'declared risk tier is "medium"',
      'path "auth/login.ts" matches high-risk pattern "auth/**"',
      'change size 420 meets the high-risk threshold (400)',
      'goal mentions "auth/authentication"',
      'goal mentions "migration"',
    ]);
  });
});

describe('factory governance risk schema', () => {
  test('keeps old factories without a risk block valid', () => {
    const parsed = factorySchema.safeParse(baseFactory());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.governance).toBeUndefined();
  });

  test('accepts a full risk block', () => {
    const parsed = factorySchema.safeParse(
      baseFactory({
        governance: {
          risk: {
            defaultTier: 'high',
            tiers: { high: { merge: 'disabled' } },
            highRiskPaths: ['auth/**', 'billing/**'],
          },
        },
      }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const risk = parsed.data.governance?.risk;
    expect(risk?.defaultTier).toBe('high');
    expect(risk?.highRiskPaths).toEqual(['auth/**', 'billing/**']);
    expect(risk?.tiers.high).toEqual({
      planApproval: 'human',
      review: 'human',
      merge: 'disabled',
    });
    expect(risk?.tiers.low).toEqual(DEFAULT_RISK_GOVERNANCE.tiers.low);
  });

  test('fills defaults for an empty risk block', () => {
    const parsed = factorySchema.safeParse(baseFactory({ governance: { risk: {} } }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.governance?.risk).toEqual(DEFAULT_RISK_GOVERNANCE);
  });

  test('rejects invalid risk enums', () => {
    expect(
      factorySchema.safeParse(
        baseFactory({ governance: { risk: { defaultTier: 'critical' } } }),
      ).success,
    ).toBe(false);
    expect(
      factorySchema.safeParse(
        baseFactory({ governance: { risk: { tiers: { high: { merge: 'yolo' } } } } }),
      ).success,
    ).toBe(false);
  });
});
