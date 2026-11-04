import { describe, expect, test } from 'bun:test';
import { buildFactoryMetrics, type MetricsInput } from '../src/metrics/compute';
import { MetricsWindowError, parseMetricsWindow } from '../src/metrics/window';
import { parseStageRunId } from '../src/metrics/queries';

const WINDOW = {
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-29T00:00:00.000Z',
  days: 28,
  label: '28d',
};

function input(overrides: Partial<MetricsInput> = {}): MetricsInput {
  return {
    window: WINDOW,
    workItems: [],
    gates: [],
    permissions: [],
    runs: [],
    checks: [],
    ...overrides,
  };
}

function metric(result: ReturnType<typeof buildFactoryMetrics>, key: string) {
  const found = result.metrics.find((candidate) => candidate.key === key);
  expect(found, `metric ${key} is missing`).toBeDefined();
  return found!;
}

describe('metrics window', () => {
  test('parses days, weeks and hours', () => {
    const now = new Date('2026-10-29T00:00:00Z');
    expect(parseMetricsWindow('7d', now).days).toBe(7);
    expect(parseMetricsWindow('2w', now).days).toBe(14);
    expect(parseMetricsWindow('24h', now).days).toBe(1);
    expect(parseMetricsWindow(undefined, now).label).toBe('30d');
  });

  test('rejects an invalid window', () => {
    expect(() => parseMetricsWindow('forever')).toThrow(MetricsWindowError);
    expect(() => parseMetricsWindow('0d')).toThrow(MetricsWindowError);
  });
});

describe('stage run attribution', () => {
  test('parses the stage run id convention and ignores chat runs', () => {
    expect(parseStageRunId('run_01HZZZZZZZZZZZZZZZZZZZZZZZ_implement_2')).toEqual({
      workItemId: 'wi_01HZZZZZZZZZZZZZZZZZZZZZZZ',
      stage: 'implement',
    });
    expect(parseStageRunId('run_01HZZZZZZZZZZZZZZZZZZZZZZZ_review_1_r2')).toEqual({
      workItemId: 'wi_01HZZZZZZZZZZZZZZZZZZZZZZZ',
      stage: 'review',
    });
    expect(parseStageRunId('run_mf3k2_ab12cd34')).toBeNull();
  });
});

describe('factory metrics', () => {
  const workItems = [
    {
      id: 'wi_A',
      type: 'task',
      status: 'done',
      createdAt: '2026-10-02T00:00:00Z',
      doneAt: '2026-10-04T00:00:00Z',
      prUrl: 'https://forge/acme/api/pull/1',
      prNumber: 1,
    },
    {
      id: 'wi_B',
      type: 'task',
      status: 'active',
      createdAt: '2026-10-10T00:00:00Z',
      doneAt: null,
      prUrl: 'https://forge/acme/api/pull/2',
      prNumber: 2,
    },
  ];

  test('computes throughput, cost per PR and per-stage attribution', () => {
    const result = buildFactoryMetrics(
      input({
        workItems,
        runs: [
          { id: 'run_x_implement_1', startedAt: '2026-10-02T01:00:00Z', costUsd: 0.5, stage: 'implement', workItemId: 'wi_A' },
          { id: 'run_x_review_1', startedAt: '2026-10-03T01:00:00Z', costUsd: 0.25, stage: 'review', workItemId: 'wi_A' },
          { id: 'run_chat', startedAt: '2026-10-03T02:00:00Z', costUsd: 0.1, stage: null, workItemId: null },
        ],
      }),
    );
    const throughput = metric(result, 'throughput');
    expect(throughput.value).toBe(0.5);
    expect(throughput.sampleSize).toBe(2);
    expect(metric(result, 'costPerPr').value).toBe(0.375);
    expect(result.costByStage).toEqual([
      { stage: 'implement', costUsd: 0.5, runCount: 1 },
      { stage: 'review', costUsd: 0.25, runCount: 1 },
    ]);
    expect(result.unattributedCost).toEqual({ costUsd: 0.1, runCount: 1 });
  });

  test('computes cycle time and time to first human review', () => {
    const result = buildFactoryMetrics(
      input({
        workItems,
        gates: [
          {
            workItemId: 'wi_A',
            gate: 'spec',
            automatic: false,
            requestedAt: '2026-10-02T00:00:00Z',
            decidedAt: '2026-10-02T06:00:00Z',
          },
          {
            workItemId: 'wi_A',
            gate: 'implement',
            automatic: true,
            requestedAt: '2026-10-02T08:00:00Z',
            decidedAt: '2026-10-02T08:01:00Z',
          },
        ],
        permissions: [{ runId: 'run_x', decidedAt: '2026-10-02T07:00:00Z' }],
      }),
    );
    expect(metric(result, 'cycleTime').value).toBe(48);
    expect(metric(result, 'cycleTime').sampleSize).toBe(1);
    expect(metric(result, 'timeToFirstHumanReview').value).toBe(6);
    expect(metric(result, 'automationPercent').value).toBe(50);
    // 1 human gate + 1 permission decision over 2 PRs.
    expect(metric(result, 'touchpointsPerPr').value).toBe(1);
  });

  test('defect rate comes from forge check results, not from diffs', () => {
    const result = buildFactoryMetrics(
      input({
        workItems,
        checks: [
          { workItemId: 'wi_A', green: false, createdAt: '2026-10-03T00:00:00Z' },
          { workItemId: 'wi_B', green: true, createdAt: '2026-10-11T00:00:00Z' },
        ],
      }),
    );
    expect(metric(result, 'defectRate').value).toBe(0.5);
    expect(metric(result, 'defectRate').sampleSize).toBe(2);
  });

  test('computes human interactions, autonomy, accepted-change cost, cycle time and code age', () => {
    const result = buildFactoryMetrics(
      input({
        workItems: [
          {
            id: 'wi_A',
            type: 'task',
            status: 'done',
            createdAt: '2026-10-02T00:00:00Z',
            doneAt: '2026-10-04T00:00:00Z',
            prUrl: 'https://forge/acme/api/pull/1',
            prNumber: 1,
            source: 'forge',
          },
          {
            id: 'wi_B',
            type: 'task',
            status: 'done',
            createdAt: '2026-10-06T00:00:00Z',
            doneAt: '2026-10-07T00:00:00Z',
            prUrl: 'https://forge/acme/api/pull/2',
            prNumber: 2,
            source: 'manual',
          },
          {
            id: 'wi_I',
            type: 'incident',
            status: 'done',
            createdAt: '2026-10-05T00:00:00Z',
            doneAt: '2026-10-05T10:00:00Z',
            prUrl: null,
            prNumber: null,
            source: 'slack',
          },
        ],
        gates: [
          {
            workItemId: 'wi_A',
            gate: 'review',
            automatic: false,
            requestedAt: '2026-10-02T12:00:00Z',
            decidedAt: '2026-10-03T00:00:00Z',
          },
        ],
        permissions: [
          { runId: 'run_x_implement_1', workItemId: 'wi_A', decidedAt: '2026-10-03T01:00:00Z' },
        ],
        runs: [
          {
            id: 'run_x_implement_1',
            startedAt: '2026-10-02T01:00:00Z',
            costUsd: 0.5,
            stage: 'implement',
            workItemId: 'wi_A',
          },
          {
            id: 'run_x_review_1',
            startedAt: '2026-10-06T01:00:00Z',
            costUsd: 0.25,
            stage: 'review',
            workItemId: 'wi_B',
          },
        ],
      }),
    );

    // 1 human gate + 1 permission over 2 PRs.
    expect(metric(result, 'humanInteractionsPerPr').value).toBe(1);
    expect(metric(result, 'humanInteractionsPerPr').sampleSize).toBe(2);
    // wi_A was touched by a human; wi_B was not.
    expect(metric(result, 'autonomyRatio').value).toBe(50);
    expect(metric(result, 'autonomyRatio').sampleSize).toBe(2);
    expect(metric(result, 'costPerAcceptedChange').value).toBe(0.375);
    expect(metric(result, 'costPerAcceptedChange').sampleSize).toBe(2);
    // Only the forge-sourced done PR counts; manual wi_B is excluded.
    expect(metric(result, 'signalToProductionCycleTime').value).toBe(48);
    expect(metric(result, 'signalToProductionCycleTime').sampleSize).toBe(1);
    expect(metric(result, 'incidentMttHours').value).toBe(10);
    expect(metric(result, 'incidentMttHours').sampleSize).toBe(1);
    // wi_A: 25 days to window end, wi_B: 22 days.
    expect(metric(result, 'mergedCodeAgeDays').value).toBe(23.5);
    expect(metric(result, 'mergedCodeAgeDays').sampleSize).toBe(2);
  });

  test('signal-to-production stays null when only manual PRs completed', () => {
    const result = buildFactoryMetrics(
      input({
        workItems: [
          {
            id: 'wi_M',
            type: 'task',
            status: 'done',
            createdAt: '2026-10-02T00:00:00Z',
            doneAt: '2026-10-04T00:00:00Z',
            prUrl: 'https://forge/acme/api/pull/9',
            prNumber: 9,
            source: 'manual',
          },
        ],
      }),
    );
    const card = metric(result, 'signalToProductionCycleTime');
    expect(card.value).toBeNull();
    expect(card.sampleSize).toBe(0);
    expect(card.reason).toContain('non-manual');
  });

  test('missing data is null with a reason, never a fabricated zero', () => {
    const result = buildFactoryMetrics(input());
    for (const key of [
      'throughput',
      'costPerPr',
      'cycleTime',
      'timeToFirstHumanReview',
      'touchpointsPerPr',
      'automationPercent',
      'defectRate',
      'humanInteractionsPerPr',
      'autonomyRatio',
      'costPerAcceptedChange',
      'signalToProductionCycleTime',
      'incidentMttHours',
      'mergedCodeAgeDays',
    ]) {
      const card = metric(result, key);
      expect(card.value).toBeNull();
      expect(card.reason).toBeTruthy();
      expect(card.sampleSize).toBe(0);
      expect(card.definition.length).toBeGreaterThan(10);
    }
  });

  test('no forge checks yields null defect rate with the forge reason', () => {
    const result = buildFactoryMetrics(input({ workItems }));
    const card = metric(result, 'defectRate');
    expect(card.value).toBeNull();
    expect(card.reason).toContain('forge check');
  });
});
