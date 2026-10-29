import { describe, expect, test } from 'bun:test';
import { computeCalibration, isCalibrated } from '../src/calibration';
import type { CalibrationItemObservation } from '../src/types';

function item(
  humanLabel: string,
  humanScore: number,
  judgeLabel: string | null,
  judgeScore: number | null,
): CalibrationItemObservation {
  return { humanLabel, humanScore, judgeLabel, judgeScore };
}

describe('calibration math', () => {
  test('below the minimum size returns insufficient_data, never a lucky pass', () => {
    const result = computeCalibration(
      [item('compliant', 1, 'compliant', 1), item('partial', 0.5, 'compliant', 1)],
      { minSize: 5 },
    );
    expect(result.status).toBe('insufficient_data');
    expect(result.verdict).toBe('insufficient_data');
    expect(result.agreementExact).toBeNull();
    expect(result.agreementWithinTolerance).toBeNull();
    expect(result.reason).toContain('at least 5');
    expect(result.confusion).toEqual({
      compliant: { compliant: 1 },
      partial: { compliant: 1 },
    });
  });

  test('exact agreement and per-label confusion are reported', () => {
    const result = computeCalibration(
      [
        item('compliant', 1, 'compliant', 1),
        item('compliant', 1, 'compliant', 1),
        item('partial', 0.5, 'partial', 0.5),
        item('non_compliant', 0, 'partial', 0.5),
      ],
      { minSize: 4, threshold: 0.75 },
    );
    expect(result.status).toBe('ok');
    expect(result.agreementExact).toBe(0.75);
    expect(result.verdict).toBe('pass');
    expect(result.confusion).toEqual({
      compliant: { compliant: 2 },
      partial: { partial: 1 },
      non_compliant: { partial: 1 },
    });
  });

  test('within-tolerance agreement counts score distance', () => {
    const result = computeCalibration(
      [
        item('compliant', 1, 'partial', 0.5),
        item('partial', 0.5, 'compliant', 1),
        item('non_compliant', 0, 'non_compliant', 0),
      ],
      { minSize: 3, threshold: 0.9, tolerance: 0.5 },
    );
    expect(result.agreementExact).toBeCloseTo(1 / 3);
    expect(result.agreementWithinTolerance).toBe(1);
    expect(result.verdict).toBe('fail');
  });

  test('a missing judge result counts as disagreement and as an unknown label', () => {
    const result = computeCalibration(
      [item('compliant', 1, null, null), item('partial', 0.5, 'partial', 0.5)],
      { minSize: 2, threshold: 0.5 },
    );
    expect(result.agreementExact).toBe(0.5);
    expect(result.confusion.compliant).toEqual({ unknown: 1 });
    expect(result.verdict).toBe('pass');
  });
});

describe('calibration gate', () => {
  test('only a passing result for the current rubric and judge model counts', () => {
    const results = [
      { rubricHash: 'a', judgeModel: 'judge-1', verdict: 'pass' },
      { rubricHash: 'b', judgeModel: 'judge-1', verdict: 'fail' },
    ];
    expect(isCalibrated(results, 'a', 'judge-1')).toBe(true);
    expect(isCalibrated(results, 'b', 'judge-1')).toBe(false);
    expect(isCalibrated(results, 'a', 'judge-2')).toBe(false);
    expect(isCalibrated([], 'a', 'judge-1')).toBe(false);
  });
});
