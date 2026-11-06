import { describe, expect, test } from 'bun:test';
import { factorySchema, mapZodIssues } from '@factory/core';
import {
  factoryBudgetExhausted,
  factoryQuotaExhausted,
  toEnvelope,
} from '../src/errors';
import { budgetConcurrencyState, budgetWindowState } from '../src/runs';

/**
 * Quota tests (change `add-retention-quotas-promotion`). DB-free: schema validation, the
 * error envelopes and the pure budget-state helpers. The window queries themselves need
 * Postgres and are exercised by the integration suite.
 */

function baseFactory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'v1alpha1',
    name: 'quota-fixture',
    repositories: [{ owner: 'acme', name: 'api' }],
    agentDefaults: { model: 'test-model' },
    gates: { review: 'human' },
    mergePolicy: 'human',
    ...overrides,
  };
}

function codes(value: unknown): string[] {
  const result = factorySchema.safeParse(value);
  if (result.success) return [];
  return mapZodIssues(result.error.issues, 'test.yaml').map((error) => error.code);
}

describe('quota schema', () => {
  test('accepts daily, monthly and concurrency quotas', () => {
    const result = factorySchema.safeParse(
      baseFactory({
        budget: {
          maxCostUsdPerDay: 25,
          maxCostUsdPerMonth: 400,
          maxConcurrentRuns: 3,
        },
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.budget?.maxCostUsdPerDay).toBe(25);
      expect(result.data.budget?.maxCostUsdPerMonth).toBe(400);
      expect(result.data.budget?.maxConcurrentRuns).toBe(3);
    }
  });

  test('keeps the existing caps valid alongside the quotas', () => {
    const result = factorySchema.safeParse(
      baseFactory({
        budget: {
          maxCostUsdPerRun: 2,
          maxCostUsdPerStage: 1,
          maxCostUsdPerFactory: 100,
          maxCostUsdPerDay: 10,
          maxCostUsdPerMonth: 90,
          maxConcurrentRuns: 1,
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  test('rejects a negative spend quota with invalid_value', () => {
    expect(codes(baseFactory({ budget: { maxCostUsdPerDay: -1 } }))).toContain('invalid_value');
    expect(codes(baseFactory({ budget: { maxCostUsdPerMonth: -0.01 } }))).toContain('invalid_value');
  });

  test('rejects a concurrency quota below one', () => {
    expect(codes(baseFactory({ budget: { maxConcurrentRuns: 0 } }))).toContain('invalid_value');
    expect(codes(baseFactory({ budget: { maxConcurrentRuns: -2 } }))).toContain('invalid_value');
  });

  test('rejects a fractional concurrency quota', () => {
    expect(codes(baseFactory({ budget: { maxConcurrentRuns: 1.5 } }))).toContain('invalid_value');
  });

  test('rejects an unknown quota field', () => {
    expect(codes(baseFactory({ budget: { maxCostUsdPerWeek: 5 } }))).toContain('unknown_field');
  });

  test('an omitted budget block stays optional', () => {
    expect(factorySchema.safeParse(baseFactory()).success).toBe(true);
  });
});

describe('quota error envelopes', () => {
  test('concurrency refusal uses factory_quota_exhausted with cap and active count', () => {
    const envelope = toEnvelope(factoryQuotaExhausted('acme/api', 'concurrency', 2, 2));
    expect(envelope.status).toBe(409);
    expect(envelope.body).toEqual({
      code: 'factory_quota_exhausted',
      message: expect.stringContaining('acme/api'),
      details: { factory: 'acme/api', quota: 'concurrency', cap: 2, active: 2 },
    });
  });

  test('daily spend refusal keeps the factory_budget_exhausted envelope and names the window', () => {
    const envelope = toEnvelope(factoryBudgetExhausted('acme/api', 5, 5.25, 'day'));
    expect(envelope.status).toBe(409);
    expect(envelope.body.code).toBe('factory_budget_exhausted');
    expect(envelope.body.details).toEqual({
      factory: 'acme/api',
      capUsd: 5,
      spentUsd: 5.25,
      window: 'day',
    });
  });

  test('lifetime refusal defaults to the lifetime window', () => {
    const envelope = toEnvelope(factoryBudgetExhausted('acme/api', 100, 100));
    expect(envelope.body.details).toMatchObject({ window: 'lifetime', capUsd: 100 });
  });
});

describe('budget state helpers', () => {
  test('an absent cap is omitted, never reported as zero', () => {
    const state = budgetWindowState(undefined, 3.5);
    expect(state).toEqual({ spentUsd: 3.5, exhausted: false });
    expect('cap' in state).toBe(false);
  });

  test('spend at or above the cap is exhausted', () => {
    expect(budgetWindowState(10, 9.99).exhausted).toBe(false);
    expect(budgetWindowState(10, 10).exhausted).toBe(true);
    expect(budgetWindowState(10, 11).exhausted).toBe(true);
  });

  test('a zero cap refuses everything, including zero spend', () => {
    expect(budgetWindowState(0, 0).exhausted).toBe(true);
  });

  test('concurrency state mirrors the window rules', () => {
    expect(budgetConcurrencyState(undefined, 4)).toEqual({ active: 4, exhausted: false });
    expect(budgetConcurrencyState(4, 3).exhausted).toBe(false);
    expect(budgetConcurrencyState(4, 4).exhausted).toBe(true);
    expect(budgetConcurrencyState(1, 0)).toEqual({ cap: 1, active: 0, exhausted: false });
  });
});
