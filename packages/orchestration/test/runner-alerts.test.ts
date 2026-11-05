import { describe, expect, test } from 'bun:test';
import type { RunnerMetrics } from '@factory/runners';
import {
  alertDedupeKey,
  evaluateHeartbeatRule,
  evaluateMetricRules,
  metricValue,
  type AlertRule,
  type HostAlertSubject,
  type MetricsSample,
} from '../src/runner-alerts';

/**
 * Pure alert-evaluator tests (spec `runner-observability`): threshold, duration, recovery
 * and heartbeat age. No Postgres: the DB upsert lives in `runner-hosts.ts`.
 */

const NOW = '2026-01-01T12:00:00.000Z';
const nowMs = Date.parse(NOW);

function sample(overrides: Partial<RunnerMetrics> = {}): RunnerMetrics {
  return {
    capturedAt: NOW,
    cpuPercent: 10,
    load1: 0.1,
    load5: 0.1,
    load15: 0.1,
    memoryTotalBytes: 8_000_000_000,
    memoryUsedBytes: 1_000_000_000,
    memoryAvailableBytes: 7_000_000_000,
    memoryUsedPercent: 12.5,
    disks: [
      { mount: '/', totalBytes: 100_000_000_000, usedBytes: 10_000_000_000, freeBytes: 90_000_000_000, usedPercent: 10 },
    ],
    agentVersion: '1.0.0',
    ...overrides,
  };
}

function rule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'cpu-warning',
    scope: 'global',
    hostId: null,
    pool: null,
    metric: 'cpu_percent',
    comparison: 'gt',
    threshold: 85,
    durationSeconds: 0,
    severity: 'warning',
    channel: 'inbox',
    enabled: true,
    ...overrides,
  };
}

const host: HostAlertSubject = {
  id: 'rhost_1',
  pool: 'default',
  lastHeartbeat: NOW,
  enrolledAt: NOW,
};

function evaluate(
  metrics: RunnerMetrics,
  rules: AlertRule[],
  history: MetricsSample[] = [],
) {
  return evaluateMetricRules({ host, metrics, rules, history });
}

describe('threshold evaluation', () => {
  test('gt fires above the threshold and reports the observed value', () => {
    const [evaluation] = evaluate(sample({ cpuPercent: 91.5 }), [rule()]);
    expect(evaluation?.firing).toBe(true);
    expect(evaluation?.value).toBe(91.5);
    expect(evaluation?.message).toContain('91.5');
    expect(evaluation?.severity).toBe('warning');
  });

  test('gt does not fire at or below the threshold', () => {
    expect(evaluate(sample({ cpuPercent: 85 }), [rule()])[0]?.firing).toBe(false);
    expect(evaluate(sample({ cpuPercent: 20 }), [rule()])[0]?.firing).toBe(false);
  });

  test('lt fires below the threshold (disk_free_bytes)', () => {
    const free = rule({
      id: 'disk-free-critical',
      metric: 'disk_free_bytes',
      comparison: 'lt',
      threshold: 10_000_000_000,
      severity: 'critical',
    });
    // min free across mounts is what matters: 2 GB on /data.
    const metrics = sample({
      disks: [
        { mount: '/', totalBytes: 100, usedBytes: 10, freeBytes: 90_000_000_000, usedPercent: 10 },
        { mount: '/data', totalBytes: 100, usedBytes: 98, freeBytes: 2_000_000_000, usedPercent: 98 },
      ],
    });
    const [evaluation] = evaluate(metrics, [free]);
    expect(evaluation?.firing).toBe(true);
    expect(evaluation?.value).toBe(2_000_000_000);
  });

  test('disk_used_percent and inode_used_percent take the worst mount', () => {
    const metrics = sample({
      disks: [
        { mount: '/', totalBytes: 100, usedBytes: 10, freeBytes: 90, usedPercent: 10, inodeUsedPercent: 20 },
        { mount: '/data', totalBytes: 100, usedBytes: 95, freeBytes: 5, usedPercent: 95, inodeUsedPercent: 97 },
      ],
    });
    expect(metricValue('disk_used_percent', metrics)).toBe(95);
    expect(metricValue('inode_used_percent', metrics)).toBe(97);
    expect(evaluate(metrics, [rule({ id: 'disk-warning', metric: 'disk_used_percent', threshold: 80 })])[0]?.firing).toBe(true);
    expect(evaluate(metrics, [rule({ id: 'inode-warning', metric: 'inode_used_percent', threshold: 90 })])[0]?.firing).toBe(true);
  });

  test('a metric the host cannot report never fires (no inode data)', () => {
    const [evaluation] = evaluate(
      sample(),
      [rule({ id: 'inode-warning', metric: 'inode_used_percent', threshold: 90 })],
    );
    expect(evaluation?.value).toBeNull();
    expect(evaluation?.firing).toBe(false);
  });

  test('queue_wait_seconds is derived from milliseconds', () => {
    const [evaluation] = evaluate(
      sample({ queueWaitMs: 900_000 }),
      [rule({ id: 'queue-wait-warning', metric: 'queue_wait_seconds', threshold: 600 })],
    );
    expect(evaluation?.value).toBe(900);
    expect(evaluation?.firing).toBe(true);
  });
});

describe('duration evaluation', () => {
  const cpuRule = rule({ id: 'cpu-warning', durationSeconds: 300 });

  function at(offsetSeconds: number, cpuPercent: number): MetricsSample {
    return {
      capturedAt: new Date(nowMs + offsetSeconds * 1000).toISOString(),
      metrics: sample({ capturedAt: new Date(nowMs + offsetSeconds * 1000).toISOString(), cpuPercent }),
    };
  }

  test('fires when every sample inside the window breaches', () => {
    const [evaluation] = evaluate(sample({ cpuPercent: 96 }), [cpuRule], [
      at(-100, 92),
      at(-200, 88),
      at(-290, 90),
    ]);
    expect(evaluation?.firing).toBe(true);
    expect(evaluation?.value).toBe(96);
    expect(evaluation?.message).toContain('300s');
  });

  test('does not fire when any sample inside the window recovers', () => {
    const [evaluation] = evaluate(sample({ cpuPercent: 96 }), [cpuRule], [
      at(-100, 92),
      at(-200, 40),
    ]);
    expect(evaluation?.firing).toBe(false);
  });

  test('ignores samples older than the window', () => {
    const [evaluation] = evaluate(sample({ cpuPercent: 96 }), [cpuRule], [
      at(-400, 99),
      at(-500, 99),
      at(-100, 92),
    ]);
    expect(evaluation?.firing).toBe(true);
  });

  test('a duration rule with no history yet is not firing', () => {
    const [evaluation] = evaluate(sample({ cpuPercent: 99 }), [cpuRule]);
    expect(evaluation?.firing).toBe(false);
  });
});

describe('recovery', () => {
  test('a recovered metric returns firing=false so the alert can resolve', () => {
    const [evaluation] = evaluate(sample({ cpuPercent: 12 }), [rule()]);
    expect(evaluation?.firing).toBe(false);
    expect(evaluation?.message).toContain('recovered');
  });
});

describe('heartbeat age', () => {
  const heartbeatRules = [
    rule({ id: 'heartbeat-warning', metric: 'heartbeat_age_seconds', threshold: 60 }),
    rule({ id: 'heartbeat-critical', metric: 'heartbeat_age_seconds', threshold: 150, severity: 'critical' }),
  ];

  test('fires once the age crosses the threshold', () => {
    const evaluations = evaluateHeartbeatRule({
      host: { ...host, lastHeartbeat: new Date(nowMs - 120_000).toISOString() },
      now: nowMs,
      rules: heartbeatRules,
    });
    expect(evaluations.map((entry) => [entry.ruleId, entry.firing])).toEqual([
      ['heartbeat-warning', true],
      ['heartbeat-critical', false],
    ]);
    expect(evaluations[0]?.value).toBe(120);
  });

  test('does not fire for a fresh heartbeat', () => {
    const evaluations = evaluateHeartbeatRule({
      host: { ...host, lastHeartbeat: new Date(nowMs - 10_000).toISOString() },
      now: nowMs,
      rules: heartbeatRules,
    });
    expect(evaluations.every((entry) => !entry.firing)).toBe(true);
  });

  test('falls back to enrollment time when no heartbeat ever arrived', () => {
    const evaluations = evaluateHeartbeatRule({
      host: { ...host, lastHeartbeat: null, enrolledAt: new Date(nowMs - 600_000).toISOString() },
      now: nowMs,
      rules: heartbeatRules,
    });
    expect(evaluations[0]?.firing).toBe(true);
    expect(evaluations[0]?.value).toBe(600);
  });

  test('a host with no timestamps at all is treated as infinitely stale', () => {
    const [evaluation] = evaluateHeartbeatRule({
      host: { ...host, lastHeartbeat: null, enrolledAt: null },
      now: nowMs,
      rules: heartbeatRules,
    });
    expect(evaluation?.firing).toBe(true);
    expect(evaluation?.value).toBeNull();
  });
});

describe('rule scope', () => {
  test('a pool rule only applies to its pool', () => {
    const poolRule = rule({ id: 'gpu-pool', scope: 'pool', pool: 'gpu', threshold: 50 });
    expect(evaluate(sample({ cpuPercent: 90 }), [poolRule])).toEqual([]);
    const gpuHost = { ...host, pool: 'gpu' };
    expect(
      evaluateMetricRules({ host: gpuHost, metrics: sample({ cpuPercent: 90 }), rules: [poolRule] })[0]
        ?.firing,
    ).toBe(true);
  });

  test('a host rule only applies to its host', () => {
    const hostRule = rule({ id: 'only-this-host', scope: 'host', hostId: 'rhost_other' });
    expect(evaluate(sample({ cpuPercent: 99 }), [hostRule])).toEqual([]);
  });

  test('disabled rules are skipped', () => {
    expect(evaluate(sample({ cpuPercent: 99 }), [rule({ enabled: false })])).toEqual([]);
  });

  test('heartbeat rules are not evaluated from metrics', () => {
    const heartbeat = rule({ metric: 'heartbeat_age_seconds' });
    expect(evaluate(sample(), [heartbeat])).toEqual([]);
  });
});

describe('dedupe key', () => {
  test('is hostId:ruleId', () => {
    expect(alertDedupeKey('rhost_1', 'cpu-warning')).toBe('rhost_1:cpu-warning');
  });
});
