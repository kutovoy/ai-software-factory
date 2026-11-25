import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_LONGITUDINAL_THRESHOLDS,
  compareLongitudinalQuality,
  type LongitudinalMetrics,
} from '../src/index';

const BASELINE: LongitudinalMetrics = {
  duplicationPercent: 4,
  cyclomaticComplexity: 10,
  linesPerSymbol: 20,
  dependencyCount: 30,
  churnPercent: 12,
  reworkRate: 8,
  medianReviewMinutes: 40,
  changeFailureRate: 5,
  publicApiChanges: 3,
  schemaChanges: 1,
};

describe('compareLongitudinalQuality', () => {
  it('reports a regression when a candidate worsens past a threshold', () => {
    const candidate: LongitudinalMetrics = {
      ...BASELINE,
      duplicationPercent: 6, // +50% > 25%
      cyclomaticComplexity: 15, // +50% > 20%
    };
    const result = compareLongitudinalQuality(BASELINE, candidate);
    expect(result.status).toBe('regression');
    expect(result.regressions).toEqual([
      { metric: 'duplicationPercent', baseline: 4, candidate: 6, limit: 25 },
      { metric: 'cyclomaticComplexity', baseline: 10, candidate: 15, limit: 20 },
    ]);
    expect(result.improvements).toEqual([]);
    expect(result.unknown).toEqual([]);
  });

  it('reports absolute regressions for dependency and API/schema growth', () => {
    const candidate: LongitudinalMetrics = {
      ...BASELINE,
      dependencyCount: 40, // +10 > 5
      publicApiChanges: 11, // > 10
      schemaChanges: 12, // > 10
    };
    const result = compareLongitudinalQuality(BASELINE, candidate);
    expect(result.status).toBe('regression');
    expect(result.regressions.map((entry) => entry.metric)).toEqual([
      'dependencyCount',
      'publicApiChanges',
      'schemaChanges',
    ]);
  });

  it('accepts an improvement and lists the improved metrics', () => {
    const candidate: LongitudinalMetrics = {
      ...BASELINE,
      duplicationPercent: 3,
      cyclomaticComplexity: 8,
      dependencyCount: 28,
      medianReviewMinutes: 30,
    };
    const result = compareLongitudinalQuality(BASELINE, candidate);
    expect(result.status).toBe('improved');
    expect(result.regressions).toEqual([]);
    expect(result.improvements.map((entry) => entry.metric)).toEqual([
      'duplicationPercent',
      'cyclomaticComplexity',
      'dependencyCount',
      'medianReviewMinutes',
    ]);
    expect(result.unknown).toEqual([]);
  });

  it('keeps a regression ahead of an improvement', () => {
    const candidate: LongitudinalMetrics = {
      ...BASELINE,
      duplicationPercent: 3, // improvement
      changeFailureRate: 10, // +100% > 25% regression
    };
    const result = compareLongitudinalQuality(BASELINE, candidate);
    expect(result.status).toBe('regression');
    expect(result.improvements.map((entry) => entry.metric)).toEqual(['duplicationPercent']);
  });

  it('never treats a missing metric as zero', () => {
    const candidate: LongitudinalMetrics = {
      ...BASELINE,
      duplicationPercent: null,
      dependencyCount: undefined,
    };
    const baseline: LongitudinalMetrics = { ...BASELINE, cyclomaticComplexity: undefined };
    const result = compareLongitudinalQuality(baseline, candidate);
    expect(result.unknown).toEqual([
      'duplicationPercent',
      'cyclomaticComplexity',
      'dependencyCount',
    ]);
    // Every remaining metric is identical, so the comparison is honest: unchanged.
    expect(result.status).toBe('unchanged');
    expect(result.regressions).toEqual([]);
  });

  it('returns unknown when nothing can be compared', () => {
    const result = compareLongitudinalQuality({}, {});
    expect(result.status).toBe('unknown');
    expect(result.unknown).toHaveLength(10);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([]);
  });

  it('honours a partial threshold override', () => {
    const candidate: LongitudinalMetrics = { ...BASELINE, duplicationPercent: 4.5 }; // +12.5%
    expect(compareLongitudinalQuality(BASELINE, candidate).status).toBe('unchanged');
    const strict = compareLongitudinalQuality(BASELINE, candidate, {
      maxDuplicationIncreasePercent: 5,
    });
    expect(strict.status).toBe('regression');
    expect(strict.regressions).toEqual([
      { metric: 'duplicationPercent', baseline: 4, candidate: 4.5, limit: 5 },
    ]);
  });

  it('ignores invalid threshold overrides and keeps defaults', () => {
    const candidate: LongitudinalMetrics = { ...BASELINE, duplicationPercent: 4.5 };
    const result = compareLongitudinalQuality(BASELINE, candidate, {
      maxDuplicationIncreasePercent: Number.NaN,
    });
    expect(result.status).toBe('unchanged');
    expect(DEFAULT_LONGITUDINAL_THRESHOLDS.maxDuplicationIncreasePercent).toBe(25);
  });

  it('is deterministic for repeated calls', () => {
    const candidate: LongitudinalMetrics = {
      ...BASELINE,
      duplicationPercent: 9,
      dependencyCount: 26,
      reworkRate: 9,
    };
    const first = compareLongitudinalQuality(BASELINE, candidate);
    const second = compareLongitudinalQuality(BASELINE, candidate);
    expect(second).toEqual(first);
  });
});
