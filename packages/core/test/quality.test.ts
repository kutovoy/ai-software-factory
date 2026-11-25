import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SLOP_BUDGETS,
  PROOF_KINDS,
  SLOP_BUDGET_TIERS,
  evaluateSlopBudget,
  factorySchema,
  highRiskPathsTouched,
  parsePatchMetrics,
  planDepthFor,
  resolveQualityConfig,
  resolveSlopBudgets,
} from '../src/index';

const APP_PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
].join('\n');

const PACKAGE_PATCH = [
  'diff --git a/package.json b/package.json',
  'index 1111111..2222222 100644',
  '--- a/package.json',
  '+++ b/package.json',
  '@@ -1,12 +1,15 @@',
  ' {',
  '   "name": "demo",',
  '   "scripts": {',
  '     "build": "tsc"',
  '   },',
  '   "dependencies": {',
  '     "react": "^18.0.0",',
  '+    "zod": "^3.23.8",',
  '+    "left-pad": "1.3.0"',
  '   },',
  '   "devDependencies": {',
  '-    "jest": "^29.0.0"',
  '+    "vitest": "^2.0.0"',
  '   }',
  ' }',
].join('\n');

function factory(quality?: unknown): Record<string, unknown> {
  const value: Record<string, unknown> = {
    schemaVersion: 'v1alpha1',
    name: 'quality-demo',
    repositories: [{ owner: 'acme', name: 'api' }],
    agentDefaults: { model: 'test-model' },
    gates: { review: 'human' },
    mergePolicy: 'human',
  };
  if (quality !== undefined) value.quality = quality;
  return value;
}

describe('slop budget defaults', () => {
  it('exposes one budget per risk tier with the shipped limits', () => {
    expect(SLOP_BUDGET_TIERS).toEqual(['low', 'medium', 'high']);
    expect(DEFAULT_SLOP_BUDGETS.low).toEqual({
      maxDiffLines: 200,
      maxChangedFiles: 5,
      maxNewDependencies: 0,
      maxDuplicationDeltaPercent: 0.5,
      maxComplexityDelta: 5,
    });
    expect(DEFAULT_SLOP_BUDGETS.medium.maxDiffLines).toBe(400);
    expect(DEFAULT_SLOP_BUDGETS.high.maxChangedFiles).toBe(20);
  });

  it('resolves defaults when no config is given', () => {
    expect(resolveSlopBudgets()).toEqual(DEFAULT_SLOP_BUDGETS);
    expect(resolveSlopBudgets(null)).toEqual(DEFAULT_SLOP_BUDGETS);
    expect(resolveSlopBudgets(undefined)).toEqual(DEFAULT_SLOP_BUDGETS);
  });

  it('merges partial tiers and fields with the defaults', () => {
    const resolved = resolveSlopBudgets({ low: { maxDiffLines: 50 } });
    expect(resolved.low).toEqual({ ...DEFAULT_SLOP_BUDGETS.low, maxDiffLines: 50 });
    expect(resolved.medium).toEqual(DEFAULT_SLOP_BUDGETS.medium);
    expect(resolved.high).toEqual(DEFAULT_SLOP_BUDGETS.high);
  });

  it('accepts a full quality config shape and ignores invalid numbers', () => {
    const resolved = resolveSlopBudgets({
      slopBudget: { high: { maxDiffLines: 1000, maxChangedFiles: -3 } },
    });
    expect(resolved.high.maxDiffLines).toBe(1000);
    expect(resolved.high.maxChangedFiles).toBe(DEFAULT_SLOP_BUDGETS.high.maxChangedFiles);
  });
});

describe('quality config resolution', () => {
  it('defaults proof to off with every kind accepted', () => {
    const resolved = resolveQualityConfig(undefined);
    expect(resolved.proof.requireForUi).toBe(false);
    expect(resolved.proof.kinds).toEqual([...PROOF_KINDS]);
    expect(resolved.slopBudget).toEqual(DEFAULT_SLOP_BUDGETS);
  });

  it('keeps valid kinds, drops unknown ones and dedupes', () => {
    const resolved = resolveQualityConfig({
      proof: { requireForUi: true, kinds: ['screenshot', 'png', 'screenshot', 'curl'] },
    });
    expect(resolved.proof.requireForUi).toBe(true);
    expect(resolved.proof.kinds).toEqual(['screenshot', 'curl']);
  });

  it('falls back to all kinds when none are usable', () => {
    const resolved = resolveQualityConfig({ proof: { kinds: ['png'] } });
    expect(resolved.proof.kinds).toEqual([...PROOF_KINDS]);
  });
});

describe('patch metrics', () => {
  it('counts added/deleted lines and changed files, excluding headers', () => {
    const metrics = parsePatchMetrics(APP_PATCH);
    expect(metrics.changedFiles).toBe(1);
    expect(metrics.additions).toBe(2);
    expect(metrics.deletions).toBe(1);
    expect(metrics.diffLines).toBe(3);
    expect(metrics.newDependencies).toBe(0);
    expect(metrics.files).toEqual([{ path: 'src/app.ts', additions: 2, deletions: 1 }]);
  });

  it('counts new dependencies from package.json dependency blocks only', () => {
    const metrics = parsePatchMetrics(PACKAGE_PATCH);
    expect(metrics.changedFiles).toBe(1);
    expect(metrics.additions).toBe(3);
    expect(metrics.deletions).toBe(1);
    expect(metrics.newDependencies).toBe(3);
  });

  it('does not count script entries as dependencies', () => {
    const patch = [
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1,3 +1,4 @@',
      '   "scripts": {',
      '     "build": "tsc",',
      '+    "lint": "eslint ."',
      '   }',
    ].join('\n');
    expect(parsePatchMetrics(patch).newDependencies).toBe(0);
  });

  it('sums several files and keeps per-file stats', () => {
    const metrics = parsePatchMetrics(`${APP_PATCH}\n${PACKAGE_PATCH}`);
    expect(metrics.changedFiles).toBe(2);
    expect(metrics.additions).toBe(5);
    expect(metrics.deletions).toBe(2);
    expect(metrics.files.map((file) => file.path)).toEqual(['src/app.ts', 'package.json']);
  });

  it('returns zeroes for empty or non-diff input and never throws', () => {
    expect(parsePatchMetrics('')).toEqual({
      changedFiles: 0,
      additions: 0,
      deletions: 0,
      diffLines: 0,
      newDependencies: 0,
      files: [],
    });
    expect(parsePatchMetrics('plain text, not a diff').changedFiles).toBe(0);
    expect(parsePatchMetrics(undefined as unknown as string).diffLines).toBe(0);
  });
});

describe('high-risk paths', () => {
  it('returns files matching a high-risk glob in input order', () => {
    const touched = highRiskPathsTouched(
      ['src/payments/charge.ts', 'src/app.ts', 'db/migrations/001_init.sql'],
      ['src/payments/**', '**/migrations/*.sql'],
    );
    expect(touched).toEqual(['src/payments/charge.ts', 'db/migrations/001_init.sql']);
  });

  it('returns nothing when no pattern matches', () => {
    expect(highRiskPathsTouched(['src/app.ts'], ['src/payments/**'])).toEqual([]);
    expect(highRiskPathsTouched([], ['**'])).toEqual([]);
  });
});

describe('slop budget evaluation', () => {
  it('passes when every known metric is within budget', () => {
    const evaluation = evaluateSlopBudget(
      {
        changedFiles: 3,
        additions: 100,
        deletions: 20,
        diffLines: 120,
        newDependencies: 0,
        duplicationDeltaPercent: 0.2,
        complexityDelta: 2,
      },
      DEFAULT_SLOP_BUDGETS.low,
    );
    expect(evaluation).toEqual({ status: 'pass', overages: [] });
  });

  it('reports every overage and marks the evaluation exceeded', () => {
    const evaluation = evaluateSlopBudget(
      {
        changedFiles: 8,
        additions: 600,
        deletions: 300,
        diffLines: 900,
        newDependencies: 2,
        duplicationDeltaPercent: 3,
        complexityDelta: 30,
      },
      DEFAULT_SLOP_BUDGETS.low,
    );
    expect(evaluation.status).toBe('exceeded');
    expect(evaluation.overages.map((overage) => overage.metric)).toEqual([
      'maxDiffLines',
      'maxChangedFiles',
      'maxNewDependencies',
      'maxDuplicationDeltaPercent',
      'maxComplexityDelta',
    ]);
    expect(evaluation.overages[0]).toEqual({ metric: 'maxDiffLines', actual: 900, limit: 200 });
  });

  it('does not fail on unknown duplication/complexity', () => {
    const evaluation = evaluateSlopBudget(
      {
        changedFiles: 2,
        additions: 40,
        deletions: 5,
        diffLines: 45,
        newDependencies: 0,
        duplicationDeltaPercent: null,
        complexityDelta: null,
      },
      DEFAULT_SLOP_BUDGETS.low,
    );
    expect(evaluation).toEqual({ status: 'pass', overages: [] });
  });

  it('reports unknown when no metric is measurable', () => {
    const evaluation = evaluateSlopBudget(
      {
        changedFiles: Number.NaN,
        additions: Number.NaN,
        deletions: Number.NaN,
        diffLines: Number.NaN,
        newDependencies: Number.NaN,
        duplicationDeltaPercent: null,
        complexityDelta: null,
      },
      DEFAULT_SLOP_BUDGETS.low,
    );
    expect(evaluation).toEqual({ status: 'unknown', overages: [] });
  });
});

describe('plan depth', () => {
  it('requires a full plan for high risk, data/API changes or high pain', () => {
    expect(planDepthFor({ riskTier: 'high' })).toBe('full');
    expect(planDepthFor({ riskTier: 'low', touchesDataOrApi: true })).toBe('full');
    expect(planDepthFor({ riskTier: 'low', expectedPain: 'high' })).toBe('full');
  });

  it('uses a light plan for medium signals', () => {
    expect(planDepthFor({ riskTier: 'medium' })).toBe('light');
    expect(planDepthFor({ riskTier: 'low', expectedPain: 'medium' })).toBe('light');
    expect(planDepthFor({ riskTier: 'low', changeSize: 150 })).toBe('light');
  });

  it('skips planning only for a low-risk reversible change of unknown size', () => {
    expect(planDepthFor({ riskTier: 'low', reversible: true })).toBe('none');
    expect(planDepthFor({ riskTier: 'low', reversible: true, changeSize: 0 })).toBe('none');
    expect(planDepthFor({ riskTier: 'low', reversible: true, changeSize: 10 })).toBe('light');
    expect(planDepthFor({ riskTier: 'low', reversible: false })).toBe('light');
  });

  it('lets high signals win over medium ones', () => {
    expect(planDepthFor({ riskTier: 'medium', expectedPain: 'high' })).toBe('full');
    expect(planDepthFor({ riskTier: 'high', reversible: true, changeSize: 0 })).toBe('full');
  });
});

describe('factory quality schema', () => {
  it('accepts a factory without a quality block', () => {
    const parsed = factorySchema.safeParse(factory());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.quality).toBeUndefined();
  });

  it('applies per-tier defaults to a partial quality block', () => {
    const parsed = factorySchema.safeParse(
      factory({
        slopBudget: { low: { maxDiffLines: 50 } },
        proof: { requireForUi: true },
      }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.quality?.slopBudget?.low).toEqual({
      ...DEFAULT_SLOP_BUDGETS.low,
      maxDiffLines: 50,
    });
    expect(parsed.data.quality?.slopBudget?.medium).toEqual(DEFAULT_SLOP_BUDGETS.medium);
    expect(parsed.data.quality?.proof?.requireForUi).toBe(true);
    expect(parsed.data.quality?.proof?.kinds).toEqual([...PROOF_KINDS]);
  });

  it('rejects unknown proof kinds and unknown quality fields', () => {
    expect(factorySchema.safeParse(factory({ proof: { kinds: ['png'] } })).success).toBe(false);
    expect(factorySchema.safeParse(factory({ slopBudget: { low: { maxDiffLines: -1 } } })).success).toBe(
      false,
    );
    expect(factorySchema.safeParse(factory({ bogus: true })).success).toBe(false);
  });
});
