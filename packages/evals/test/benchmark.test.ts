import { describe, expect, it } from 'bun:test';
import {
  BenchmarkError,
  MAX_BENCHMARK_CONFIGURATIONS,
  aggregateBenchmark,
  benchmarkConfigHash,
  buildBenchmarkTrials,
  estimateBenchmarkCost,
  isFullMatrix,
  medianRunCost,
  paretoFrontier,
  validateBenchmarkSuite,
  type BenchmarkSuiteDescriptor,
  type BenchmarkTaskDescriptor,
} from '../src/benchmark';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function task(slug: string, overrides: Partial<BenchmarkTaskDescriptor> = {}): BenchmarkTaskDescriptor {
  return {
    slug,
    path: `benchmarks/review/tasks/${slug}.yaml`,
    title: slug,
    prompt: `do ${slug}`,
    successCriteria: 'it works',
    startingRepoRefs: [`github.com:acme/api@${SHA}`],
    tags: [],
    sourceRunId: null,
    replayFrom: null,
    ...overrides,
  };
}

function suite(overrides: Partial<BenchmarkSuiteDescriptor> = {}): BenchmarkSuiteDescriptor {
  return {
    name: 'review',
    path: 'benchmarks/review/suite.yaml',
    description: null,
    agent: 'review',
    configurations: [
      { name: 'Baseline', agents: [{ agent: 'review', model: 'sonnet' }] },
      { name: 'Candidate', agents: [{ agent: 'review', model: 'haiku' }] },
    ],
    tasks: [task('a'), task('b')],
    ...overrides,
  };
}

describe('benchmark validation', () => {
  it('rejects a task without a full 40-char SHA', () => {
    const bad = task('a', { startingRepoRefs: ['github.com:acme/api@abc123'] });
    expect(() => validateBenchmarkSuite({ ...suite(), tasks: ['a', 'b'] } as never, [bad, task('b')])).toThrow(
      BenchmarkError,
    );
    try {
      validateBenchmarkSuite(
        {
          name: 'review',
          agent: 'review',
          configurations: [{ name: 'Baseline' }],
          tasks: ['a', 'b'],
        } as never,
        [bad, task('b')],
      );
    } catch (error) {
      expect((error as BenchmarkError).code).toBe('invalid_sha');
    }
  });

  it('rejects too many configurations with a stable code', () => {
    const configurations = Array.from({ length: MAX_BENCHMARK_CONFIGURATIONS + 1 }, (_, index) => ({
      name: `c${index}`,
    }));
    try {
      validateBenchmarkSuite(
        { name: 'review', agent: 'review', configurations, tasks: ['a'] } as never,
        [task('a')],
      );
      throw new Error('expected a validation error');
    } catch (error) {
      expect((error as BenchmarkError).code).toBe('too_many_configurations');
    }
  });

  it('rejects duplicate tasks and duplicate configuration names', () => {
    try {
      validateBenchmarkSuite(
        {
          name: 'review',
          agent: 'review',
          configurations: [{ name: 'Baseline' }],
          tasks: ['a', 'a'],
        } as never,
        [task('a')],
      );
      throw new Error('expected a validation error');
    } catch (error) {
      expect((error as BenchmarkError).code).toBe('duplicate_tasks');
    }

    try {
      validateBenchmarkSuite(
        {
          name: 'review',
          agent: 'review',
          configurations: [{ name: 'Baseline' }, { name: 'Baseline' }],
          tasks: ['a'],
        } as never,
        [task('a')],
      );
      throw new Error('expected a validation error');
    } catch (error) {
      expect((error as BenchmarkError).code).toBe('duplicate_configurations');
    }
  });

  it('rejects a task file that is not listed exactly once', () => {
    try {
      validateBenchmarkSuite(
        { name: 'review', agent: 'review', configurations: [{ name: 'Baseline' }], tasks: ['a'] } as never,
        [task('a'), task('b')],
      );
      throw new Error('expected a validation error');
    } catch (error) {
      expect((error as BenchmarkError).code).toBe('benchmark_task_mismatch');
    }
  });
});

describe('configuration matrix and hash', () => {
  it('is stable across configuration and task order', () => {
    const first = suite();
    const reordered = suite({
      configurations: [...suite().configurations].reverse(),
      tasks: [...suite().tasks].reverse(),
    });
    expect(benchmarkConfigHash(first, 'a'.repeat(40))).toBe(
      benchmarkConfigHash(reordered, 'a'.repeat(40)),
    );
  });

  it('changes when a configuration, a task set or the definition commit changes', () => {
    const base = benchmarkConfigHash(suite(), 'a'.repeat(40));
    const changedModel = suite({
      configurations: [
        { name: 'Baseline', agents: [{ agent: 'review', model: 'opus' }] },
        { name: 'Candidate', agents: [{ agent: 'review', model: 'haiku' }] },
      ],
    });
    expect(benchmarkConfigHash(changedModel, 'a'.repeat(40))).not.toBe(base);
    expect(benchmarkConfigHash(suite(), 'b'.repeat(40))).not.toBe(base);
    expect(
      benchmarkConfigHash(suite({ tasks: [task('a')] }), 'a'.repeat(40)),
    ).not.toBe(base);
  });

  it('builds the full matrix and detects a partial selection', () => {
    const trials = buildBenchmarkTrials(suite());
    expect(trials).toHaveLength(4);
    expect(new Set(trials.map((trial) => `${trial.configuration}:${trial.task}`)).size).toBe(4);

    expect(isFullMatrix(suite(), {})).toBe(true);
    expect(isFullMatrix(suite(), { tasks: ['a'] })).toBe(false);
    expect(isFullMatrix(suite(), { configurations: ['Baseline'] })).toBe(false);

    expect(() => buildBenchmarkTrials(suite(), { tasks: ['nope'] })).toThrow(BenchmarkError);
  });

  it('carries a task replay source into every trial', () => {
    const replayTask = task('a', { replayFrom: 'run_01JABCDEFGHJKMNPQRSTVWXYZ0' });
    const trials = buildBenchmarkTrials(suite({ tasks: [replayTask, task('b')] }));
    expect(trials.filter((trial) => trial.task === 'a').every((trial) => trial.replayFrom === 'run_01JABCDEFGHJKMNPQRSTVWXYZ0')).toBe(true);
    expect(trials.filter((trial) => trial.task === 'b').every((trial) => trial.replayFrom === null)).toBe(true);
  });

  it('rejects a replay source that is not a run id', () => {
    const bad = task('a', { replayFrom: 'runs/whatever' });
    expect(() => validateBenchmarkSuite({ name: 'review', agent: 'review', configurations: [{ name: 'Baseline' }], tasks: ['a', 'b'] } as never, [bad, task('b')])).toThrow(BenchmarkError);
    try {
      validateBenchmarkSuite({ name: 'review', agent: 'review', configurations: [{ name: 'Baseline' }], tasks: ['a', 'b'] } as never, [bad, task('b')]);
    } catch (error) {
      expect((error as BenchmarkError).code).toBe('invalid_replay_source');
    }
  });
});

describe('cost estimate', () => {
  it('uses the median comparable run cost and the confirmation threshold', () => {
    expect(medianRunCost([1, 2, 3], 9)).toBe(2);
    expect(medianRunCost([1, 2, 3, 4], 9)).toBe(2.5);
    expect(medianRunCost([], 0.5)).toBe(0.5);

    const estimate = estimateBenchmarkCost({
      trials: 4,
      comparableRunCosts: [0.2, 0.4, 0.6],
      fallbackRunCostUsd: 9,
      thresholdUsd: 1,
    });
    expect(estimate.medianRunCostUsd).toBe(0.4);
    expect(estimate.estimateUsd).toBe(1.6);
    expect(estimate.requiresConfirmation).toBe(true);

    const below = estimateBenchmarkCost({
      trials: 2,
      comparableRunCosts: [],
      fallbackRunCostUsd: 0.5,
      thresholdUsd: 5,
    });
    expect(below.estimateUsd).toBe(1);
    expect(below.requiresConfirmation).toBe(false);
  });
});

describe('aggregation', () => {
  const trials = [
    { configuration: 'Baseline', task: 'a', status: 'ok' as const, score: 1, passing: true, costUsd: 0.1, uncalibrated: false },
    { configuration: 'Baseline', task: 'b', status: 'ok' as const, score: 0, passing: false, costUsd: 0.1, uncalibrated: false },
    { configuration: 'Candidate', task: 'a', status: 'ok' as const, score: 1, passing: true, costUsd: 0.1, uncalibrated: false },
    { configuration: 'Candidate', task: 'b', status: 'error' as const, errorCode: 'run_error', score: null, passing: false, costUsd: 0.05, uncalibrated: false },
  ];

  it('reports pass rate, weighted score, samples, cost and errors per configuration', () => {
    const aggregate = aggregateBenchmark(trials);
    const baseline = aggregate.configurations.find((c) => c.configuration === 'Baseline')!;
    expect(baseline.passRate).toBe(0.5);
    expect(baseline.weightedScore).toBe(0.5);
    expect(baseline.sampleSize).toBe(2);
    expect(baseline.passingCount).toBe(1);
    expect(baseline.costUsd).toBe(0.2);
    expect(baseline.errors).toBe(0);

    const candidate = aggregate.configurations.find((c) => c.configuration === 'Candidate')!;
    expect(candidate.passRate).toBe(1);
    expect(candidate.sampleSize).toBe(1);
    expect(candidate.errors).toBe(1);

    expect(aggregate.sampleSize).toBe(3);
    expect(aggregate.passRate).toBeCloseTo(2 / 3);
    expect(aggregate.costUsd).toBeCloseTo(0.35);
    expect(aggregate.errors).toBe(1);
    expect(aggregate.calibrationOk).toBe(true);
  });

  it('marks an uncalibrated judge benchmark as not passed and calibration not ok', () => {
    const aggregate = aggregateBenchmark([
      { configuration: 'Baseline', task: 'a', status: 'ok', score: 1, passing: true, costUsd: 0, uncalibrated: true },
    ]);
    expect(aggregate.uncalibrated).toBe(true);
    expect(aggregate.calibrationOk).toBe(false);
    expect(aggregate.passed).toBe(false);
  });

  it('never fabricates a pass rate when there are no successful samples', () => {
    const aggregate = aggregateBenchmark([
      { configuration: 'Baseline', task: 'a', status: 'error', errorCode: 'x', score: null, passing: false, costUsd: 0, uncalibrated: false },
    ]);
    expect(aggregate.passRate).toBeNull();
    expect(aggregate.passed).toBe(false);
  });
});

describe('Pareto frontier', () => {
  it('reports a single recommendation only when one configuration dominates', () => {
    const analysis = paretoFrontier([
      { configuration: 'Fast', passRate: 1, costUsd: 1 },
      { configuration: 'Slow', passRate: 0.5, costUsd: 2 },
    ]);
    expect(analysis.frontier).toEqual(['Fast']);
    expect(analysis.dominated).toEqual([{ configuration: 'Slow', by: 'Fast' }]);
    expect(analysis.recommendation).toEqual({ configuration: 'Fast', reason: 'dominance' });
    expect(analysis.labels.highest_performance).toBe('Fast');
    expect(analysis.labels.lowest_cost).toBe('Fast');
    expect(analysis.labels.most_efficient).toBe('Fast');
  });

  it('keeps a real trade-off on the frontier and refuses a single winner', () => {
    const analysis = paretoFrontier([
      { configuration: 'Accurate', passRate: 0.95, costUsd: 4 },
      { configuration: 'Cheap', passRate: 0.7, costUsd: 1 },
    ]);
    expect(analysis.frontier).toEqual(['Accurate', 'Cheap']);
    expect(analysis.recommendation).toBeNull();
    expect(analysis.reason).toBe('pareto_frontier');
    expect(analysis.labels.highest_performance).toBe('Accurate');
    expect(analysis.labels.lowest_cost).toBe('Cheap');
    expect(analysis.labels.most_efficient).toBe('Cheap');
  });

  it('handles zero-cost configurations and no samples honestly', () => {
    const free = paretoFrontier([
      { configuration: 'Free', passRate: 0.8, costUsd: 0 },
      { configuration: 'Paid', passRate: 0.8, costUsd: 1 },
    ]);
    expect(free.frontier).toEqual(['Free']);
    expect(free.labels.most_efficient).toBe('Free');

    const empty = paretoFrontier([{ configuration: 'None', passRate: null, costUsd: 1 }]);
    expect(empty.frontier).toEqual([]);
    expect(empty.recommendation).toBeNull();
    expect(empty.reason).toBe('no_samples');
  });
});
