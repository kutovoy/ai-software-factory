import { describe, expect, test } from 'bun:test';
import {
  budgetState,
  decideJudgeSampling,
  isSampled,
  isWithinCadence,
} from '../src/sampling';

describe('deterministic sampling', () => {
  test('the same run id always yields the same decision', () => {
    for (let index = 0; index < 50; index += 1) {
      const runId = `run_${index}`;
      expect(isSampled(runId, 25)).toBe(isSampled(runId, 25));
    }
  });

  test('0% never samples and 100% always samples', () => {
    for (let index = 0; index < 20; index += 1) {
      expect(isSampled(`run_${index}`, 0)).toBe(false);
      expect(isSampled(`run_${index}`, 100)).toBe(true);
    }
  });

  test('25% selects roughly a quarter of a large corpus', () => {
    let selected = 0;
    for (let index = 0; index < 2000; index += 1) {
      if (isSampled(`run_corpus_${index}`, 25)) selected += 1;
    }
    expect(selected / 2000).toBeGreaterThan(0.2);
    expect(selected / 2000).toBeLessThan(0.3);
  });
});

describe('cadence', () => {
  test('no cadence always allows scoring', () => {
    expect(isWithinCadence(null, 0, Date.now())).toBe(true);
  });

  test('a recent score is skipped until the cadence elapses', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    expect(isWithinCadence(new Date(now - 1000).toISOString(), 60_000, now)).toBe(false);
    expect(isWithinCadence(new Date(now - 120_000).toISOString(), 60_000, now)).toBe(true);
  });
});

describe('daily budget', () => {
  test('budget state never goes negative', () => {
    expect(budgetState(5, 10)).toEqual({ usedToday: 5, maxPerDay: 10, remaining: 5 });
    expect(budgetState(11, 10)).toEqual({ usedToday: 11, maxPerDay: 10, remaining: 0 });
  });

  test('budget exhaustion wins over force', () => {
    const decision = decideJudgeSampling({
      runId: 'run_x',
      samplingRate: 100,
      usedToday: 10,
      maxPerDay: 10,
      lastScoredAt: null,
      cadenceMs: 0,
      force: true,
    });
    expect(decision).toEqual({ selected: false, reason: 'budget_exhausted' });
  });

  test('force bypasses sampling and cadence but respects budget', () => {
    const decision = decideJudgeSampling({
      runId: 'run_never_sampled',
      samplingRate: 0,
      usedToday: 0,
      maxPerDay: 10,
      lastScoredAt: new Date().toISOString(),
      cadenceMs: 60_000,
      force: true,
    });
    expect(decision).toEqual({ selected: true, reason: null });
  });

  test('sampled_out and cadence are reported distinctly', () => {
    expect(
      decideJudgeSampling({
        runId: 'run_x',
        samplingRate: 0,
        usedToday: 0,
        maxPerDay: 10,
        lastScoredAt: null,
        cadenceMs: 0,
      }).reason,
    ).toBe('sampled_out');

    expect(
      decideJudgeSampling({
        runId: 'run_x',
        samplingRate: 100,
        usedToday: 0,
        maxPerDay: 10,
        lastScoredAt: new Date().toISOString(),
        cadenceMs: 60_000,
      }).reason,
    ).toBe('cadence');
  });
});
