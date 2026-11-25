import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_REVIEW_CAPACITY,
  DEFAULT_SLOP_BUDGETS,
  evaluateReviewCapacity,
  factorySchema,
  resolveQualityConfig,
  resolveReviewCapacity,
} from '../src/index';

function factory(quality?: unknown): Record<string, unknown> {
  const value: Record<string, unknown> = {
    schemaVersion: 'v1alpha1',
    name: 'capacity-demo',
    repositories: [{ owner: 'acme', name: 'api' }],
    agentDefaults: { model: 'test-model' },
    gates: { review: 'human' },
    mergePolicy: 'human',
  };
  if (quality !== undefined) value.quality = quality;
  return value;
}

describe('resolveReviewCapacity', () => {
  it('reports the shipped defaults for an absent config', () => {
    expect(resolveReviewCapacity(undefined)).toEqual(DEFAULT_REVIEW_CAPACITY);
    expect(resolveReviewCapacity(null)).toEqual(DEFAULT_REVIEW_CAPACITY);
    expect(resolveReviewCapacity({})).toEqual(DEFAULT_REVIEW_CAPACITY);
  });

  it('inherits defaults for a partial config', () => {
    expect(resolveReviewCapacity({ maxOpenGates: 5 })).toEqual({
      maxOpenGates: 5,
      maxUnreadDiffLines: DEFAULT_REVIEW_CAPACITY.maxUnreadDiffLines,
      maxGateAgeHours: DEFAULT_REVIEW_CAPACITY.maxGateAgeHours,
      maxReviewHoursPerWeek: DEFAULT_REVIEW_CAPACITY.maxReviewHoursPerWeek,
    });
  });

  it('accepts a full quality block and floors integer caps', () => {
    const resolved = resolveReviewCapacity({
      reviewCapacity: {
        maxOpenGates: 7.9,
        maxUnreadDiffLines: 1200.5,
        maxGateAgeHours: 12,
        maxReviewHoursPerWeek: 8,
      },
    });
    expect(resolved).toEqual({
      maxOpenGates: 7,
      maxUnreadDiffLines: 1200,
      maxGateAgeHours: 12,
      maxReviewHoursPerWeek: 8,
    });
  });

  it('ignores invalid values instead of failing', () => {
    const resolved = resolveReviewCapacity({
      maxOpenGates: -3,
      maxUnreadDiffLines: 'many',
      maxGateAgeHours: Number.NaN,
      maxReviewHoursPerWeek: null,
    });
    expect(resolved).toEqual(DEFAULT_REVIEW_CAPACITY);
  });
});

describe('evaluateReviewCapacity', () => {
  it('is not saturated inside every cap', () => {
    const status = evaluateReviewCapacity(
      { openGates: 3, unreadDiffLines: 800, oldestGateHours: 4 },
      DEFAULT_REVIEW_CAPACITY,
    );
    expect(status.saturated).toBe(false);
    expect(status.reasons).toEqual([]);
    expect(status.openGates).toBe(3);
    expect(status.unreadDiffLines).toBe(800);
    expect(status.oldestGateHours).toBe(4);
  });

  it('names each exceeded cap in a stable order', () => {
    const status = evaluateReviewCapacity(
      { openGates: 21, unreadDiffLines: 4500, oldestGateHours: 60, reviewHoursPerWeek: 25 },
      DEFAULT_REVIEW_CAPACITY,
    );
    expect(status.saturated).toBe(true);
    expect(status.reasons).toEqual([
      'open gates 21 > 20',
      'unread diff lines 4500 > 4000',
      'oldest gate 60h > 48h',
      'review hours 25 > 20',
    ]);
  });

  it('does not check review hours when the measurement is absent', () => {
    const status = evaluateReviewCapacity(
      { openGates: 1, unreadDiffLines: 10, oldestGateHours: 1 },
      { ...DEFAULT_REVIEW_CAPACITY, maxReviewHoursPerWeek: 1 },
    );
    expect(status.saturated).toBe(false);
    expect(status.reasons).toEqual([]);
  });

  it('treats a single gate over the limit as saturated', () => {
    const status = evaluateReviewCapacity(
      { openGates: 1, unreadDiffLines: 0, oldestGateHours: 0 },
      { ...DEFAULT_REVIEW_CAPACITY, maxOpenGates: 0 },
    );
    expect(status.saturated).toBe(true);
    expect(status.reasons).toEqual(['open gates 1 > 0']);
  });
});

describe('resolveQualityConfig review capacity', () => {
  it('adds reviewCapacity while keeping the existing fields', () => {
    const resolved = resolveQualityConfig({ reviewCapacity: { maxOpenGates: 4 } });
    expect(resolved.reviewCapacity.maxOpenGates).toBe(4);
    expect(resolved.reviewCapacity.maxUnreadDiffLines).toBe(
      DEFAULT_REVIEW_CAPACITY.maxUnreadDiffLines,
    );
    expect(resolved.slopBudget.low).toEqual(DEFAULT_SLOP_BUDGETS.low);
    expect(resolved.proof.requireForUi).toBe(false);
  });

  it('defaults when quality is absent', () => {
    expect(resolveQualityConfig(undefined).reviewCapacity).toEqual(DEFAULT_REVIEW_CAPACITY);
  });
});

describe('factory schema review capacity', () => {
  it('keeps old factories valid without reviewCapacity', () => {
    const parsed = factorySchema.safeParse(factory({ slopBudget: { low: { maxDiffLines: 100 } } }));
    expect(parsed.success).toBe(true);
  });

  it('accepts a partial reviewCapacity block', () => {
    const parsed = factorySchema.safeParse(
      factory({ reviewCapacity: { maxOpenGates: 3, maxGateAgeHours: 24 } }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.quality?.reviewCapacity?.maxOpenGates).toBe(3);
      expect(parsed.data.quality?.reviewCapacity?.maxGateAgeHours).toBe(24);
    }
  });

  it('rejects negative or unknown capacity fields', () => {
    expect(factorySchema.safeParse(factory({ reviewCapacity: { maxOpenGates: -1 } })).success).toBe(
      false,
    );
    expect(factorySchema.safeParse(factory({ reviewCapacity: { maxOpenGate: 3 } })).success).toBe(
      false,
    );
  });
});
