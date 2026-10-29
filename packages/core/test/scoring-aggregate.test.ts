import { describe, expect, test } from 'bun:test';
import { aggregateScoreRows } from '../src/scoring/aggregate';
import type { ScoreAggregateRow } from '../src/scoring/types';

function row(overrides: Partial<ScoreAggregateRow> = {}): ScoreAggregateRow {
  return {
    scorer: 'scope',
    scorerClass: 'judge',
    status: 'ok',
    score: 1,
    passing: true,
    uncalibrated: false,
    costUsd: 0,
    ...overrides,
  };
}

describe('score aggregation', () => {
  test('weights the pass rate by score and counts samples', () => {
    const aggregates = aggregateScoreRows([
      row({ score: 1, passing: true }),
      row({ score: 0.5, passing: false }),
      row({ score: 0, passing: false }),
      row({ status: 'error', score: null, passing: false }),
      row({ status: 'skipped', score: null, passing: false }),
    ]);
    expect(aggregates).toHaveLength(1);
    const aggregate = aggregates[0]!;
    expect(aggregate.sampleCount).toBe(3);
    expect(aggregate.passingCount).toBe(1);
    expect(aggregate.passRate).toBeCloseTo(1 / 3);
    expect(aggregate.weightedScore).toBeCloseTo(0.5);
    expect(aggregate.errorCount).toBe(1);
    expect(aggregate.skippedCount).toBe(1);
  });

  test('an uncalibrated judge is not benchmark eligible', () => {
    const aggregates = aggregateScoreRows([
      row({ uncalibrated: true }),
      row({ scorer: 'checks', scorerClass: 'deterministic', uncalibrated: false }),
    ]);
    expect(aggregates.find((aggregate) => aggregate.scorer === 'scope')!.benchmarkEligible).toBe(false);
    expect(aggregates.find((aggregate) => aggregate.scorer === 'checks')!.benchmarkEligible).toBe(true);
  });

  test('no successful samples yields null pass rate and weighted score', () => {
    const aggregates = aggregateScoreRows([
      row({ status: 'error', score: null, passing: false }),
      row({ status: 'skipped', score: null, passing: false }),
    ]);
    expect(aggregates[0]!.passRate).toBeNull();
    expect(aggregates[0]!.weightedScore).toBeNull();
    expect(aggregates[0]!.benchmarkEligible).toBe(false);
  });

  test('cost is summed across all statuses', () => {
    const aggregates = aggregateScoreRows([
      row({ costUsd: 0.01 }),
      row({ status: 'error', costUsd: 0.02 }),
    ]);
    expect(aggregates[0]!.costUsd).toBeCloseTo(0.03);
  });
});
