import { describe, expect, test } from 'bun:test';
import { aggregateScoreRows, buildFactoryMetrics, parseMetricsWindow } from '@factory/core';
import { decideJudgeSampling } from '@factory/evals';
import { calibrationBodySchema, scoringBodySchema } from '../src/scoring';
import { toEnvelope } from '../src/errors';
import { ApiError } from '../src/errors';

const WINDOW = parseMetricsWindow('30d', new Date('2026-10-29T00:00:00Z'));

describe('scoring request schemas', () => {
  test('accepts an on-demand run score request', () => {
    const parsed = scoringBodySchema.safeParse({
      runId: 'run_123',
      force: true,
    });
    expect(parsed.success).toBe(true);
  });

  test('rejects unknown fields and unknown stages', () => {
    expect(
      scoringBodySchema.safeParse({ bogus: true }).success,
    ).toBe(false);
    expect(
      scoringBodySchema.safeParse({ stage: 'deploy' }).success,
    ).toBe(false);
  });

  test('calibration requires items or an existing set', () => {
    expect(
      calibrationBodySchema.safeParse({ scorer: 'scope' }).success,
    ).toBe(false);
    expect(
      calibrationBodySchema.safeParse({
        scorer: 'scope',
        items: [{ runId: 'run_1', humanLabel: 'compliant' }],
      }).success,
    ).toBe(true);
    expect(
      calibrationBodySchema.safeParse({
        scorer: 'scope',
        setId: 'cal_1',
      }).success,
    ).toBe(true);
  });
});

describe('score aggregation', () => {
  test('returns a weighted pass rate with sample counts', () => {
    const aggregates = aggregateScoreRows([
      { scorer: 'scope', scorerClass: 'judge', status: 'ok', score: 1, passing: true, uncalibrated: true, costUsd: 0.01 },
      { scorer: 'scope', scorerClass: 'judge', status: 'ok', score: 0.5, passing: false, uncalibrated: true, costUsd: 0.01 },
      { scorer: 'scope', scorerClass: 'judge', status: 'error', score: null, passing: false, uncalibrated: false, costUsd: 0 },
      { scorer: 'checks', scorerClass: 'deterministic', status: 'ok', score: 1, passing: true, uncalibrated: false, costUsd: 0 },
    ]);
    const judge = aggregates.find((aggregate) => aggregate.scorer === 'scope')!;
    expect(judge.sampleCount).toBe(2);
    expect(judge.passRate).toBe(0.5);
    expect(judge.weightedScore).toBe(0.75);
    expect(judge.errorCount).toBe(1);
    expect(judge.costUsd).toBeCloseTo(0.02);
    expect(judge.benchmarkEligible).toBe(false);
  });
});

describe('metrics null states', () => {
  test('every metric without data is null with a reason', () => {
    const result = buildFactoryMetrics({
      window: WINDOW,
      workItems: [],
      gates: [],
      permissions: [],
      runs: [],
      checks: [],
    });
    for (const metric of result.metrics) {
      expect(metric.value).toBeNull();
      expect(metric.reason).toBeTruthy();
      expect(metric.definition.length).toBeGreaterThan(10);
      expect(metric.sampleSize).toBe(0);
    }
  });
});

describe('budget exhaustion', () => {
  test('a judge is skipped with budget_exhausted when the daily cap is reached', () => {
    const decision = decideJudgeSampling({
      runId: 'run_123',
      samplingRate: 100,
      usedToday: 200,
      maxPerDay: 200,
      lastScoredAt: null,
      cadenceMs: 0,
      force: true,
    });
    expect(decision).toEqual({ selected: false, reason: 'budget_exhausted' });
  });

  test('the budget error surfaces as a stable API envelope', () => {
    const envelope = toEnvelope(
      new ApiError('budget_exhausted', 409, 'daily judge budget exhausted', {
        factory: 'example',
        usedToday: 200,
        maxPerDay: 200,
      }),
    );
    expect(envelope.status).toBe(409);
    expect(envelope.body.code).toBe('budget_exhausted');
  });
});
