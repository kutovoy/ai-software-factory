import { describe, expect, it } from 'bun:test';
import {
  assignCanaryVersion,
  canaryBucket,
  emptyCanaryStats,
  evaluateCanaryObservation,
  withRates,
  type CanaryVersionStats,
} from '../src/index';

/**
 * Canary routing + observation are pure functions (ADR-021): the same work-item id always
 * lands on the same version, and "regression" has exactly one definition shared by the
 * workflow, the API projection and the tests.
 */

function stats(version: 'stable' | 'candidate', overrides: Partial<CanaryVersionStats> = {}): CanaryVersionStats {
  return withRates({
    ...emptyCanaryStats(version),
    ...overrides,
  });
}

describe('canary routing', () => {
  it('is deterministic for a work item id', () => {
    const id = 'wi_01J0000000000000000000000';
    expect(canaryBucket(id)).toBe(canaryBucket(id));
    expect(assignCanaryVersion(id, 37)).toBe(assignCanaryVersion(id, 37));
    for (let index = 0; index < 200; index += 1) {
      const generated = `wi_${String(index).padStart(26, '0')}`;
      expect(canaryBucket(generated)).toBeGreaterThanOrEqual(0);
      expect(canaryBucket(generated)).toBeLessThan(100);
    }
  });

  it('routes everything at 100% and nothing at 0%', () => {
    for (let index = 0; index < 50; index += 1) {
      const id = `wi_${String(index).padStart(26, 'A')}`;
      expect(assignCanaryVersion(id, 100)).toBe('candidate');
      expect(assignCanaryVersion(id, 0)).toBe('stable');
    }
  });

  it('splits close to the configured percentage over many ids', () => {
    const ids = Array.from({ length: 1_000 }, (_, index) => `wi_${String(index).padStart(26, 'B')}`);
    const candidate = ids.filter((id) => assignCanaryVersion(id, 25) === 'candidate').length;
    expect(candidate).toBeGreaterThan(150);
    expect(candidate).toBeLessThan(350);
  });

  it('clamps an out-of-range percentage instead of throwing', () => {
    const id = 'wi_01J0000000000000000000000';
    expect(assignCanaryVersion(id, -10)).toBe('stable');
    expect(assignCanaryVersion(id, 250)).toBe('candidate');
  });
});

describe('canary observation', () => {
  it('promotes when the candidate matches stable', () => {
    const observation = evaluateCanaryObservation({
      stable: stats('stable', { scores: 10, passing: 8, runs: 12, failedRuns: 2 }),
      candidate: stats('candidate', { scores: 6, passing: 5, runs: 7, failedRuns: 1 }),
      threshold: 0.1,
    });
    expect(observation.stable.passRate).toBe(0.8);
    expect(observation.candidate.passRate).toBeCloseTo(0.8333, 3);
    expect(observation.regressionExceeded).toBe(false);
    expect(observation.reason).toBeNull();
    expect(observation.insufficientData).toBe(false);
    expect(observation.evidence).toMatchObject({ threshold: 0.1 });
  });

  it('flags a pass-rate regression beyond the threshold', () => {
    const observation = evaluateCanaryObservation({
      stable: stats('stable', { scores: 10, passing: 9, runs: 10 }),
      candidate: stats('candidate', { scores: 10, passing: 6, runs: 10 }),
      threshold: 0.1,
    });
    expect(observation.passRateDelta).toBe(-0.3);
    expect(observation.regressionExceeded).toBe(true);
    expect(observation.reason).toBe('pass_rate_regression');
    expect(observation.detail).toContain('candidate pass rate');
  });

  it('flags an incident-rate regression beyond the threshold', () => {
    const observation = evaluateCanaryObservation({
      stable: stats('stable', { scores: 4, passing: 4, runs: 10, failedRuns: 0 }),
      candidate: stats('candidate', { scores: 4, passing: 4, runs: 10, failedRuns: 3 }),
      threshold: 0.2,
    });
    expect(observation.failureRateDelta).toBe(0.3);
    expect(observation.regressionExceeded).toBe(true);
    expect(observation.reason).toBe('incident_rate_regression');
  });

  it('reports insufficient data when the candidate has no evidence', () => {
    const observation = evaluateCanaryObservation({
      stable: stats('stable', { scores: 5, passing: 4, runs: 6 }),
      candidate: emptyCanaryStats('candidate'),
      threshold: 0.1,
    });
    expect(observation.passRateDelta).toBeNull();
    expect(observation.failureRateDelta).toBeNull();
    expect(observation.regressionExceeded).toBe(false);
    expect(observation.insufficientData).toBe(true);
  });

  it('treats a candidate improvement as no regression', () => {
    const observation = evaluateCanaryObservation({
      stable: stats('stable', { scores: 10, passing: 5, runs: 10 }),
      candidate: stats('candidate', { scores: 10, passing: 9, runs: 10 }),
      threshold: 0,
    });
    expect(observation.passRateDelta).toBe(0.4);
    expect(observation.regressionExceeded).toBe(false);
  });
});
