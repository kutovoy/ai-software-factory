import type { RunnerMetrics } from '@factory/runners';

/**
 * Runner alert evaluation (spec `runner-observability`).
 *
 * Deliberately pure: the evaluators take a host snapshot, the latest metrics sample, the
 * enabled rules and recent history, and return `AlertEvaluation[]`. The DB upsert/resolve
 * lives in `runner-hosts.ts` (`applyAlertEvaluations`), so this module is unit-testable
 * without Postgres and can be reused by the worker's stale-heartbeat loop.
 */

export type RunnerAlertComparison = 'gt' | 'lt';
export type RunnerAlertSeverity = 'warning' | 'critical';
export type RunnerAlertState = 'firing' | 'acknowledged' | 'resolved' | 'silenced';
export type RunnerAlertScope = 'global' | 'pool' | 'host';

/** A row of `runner_alert_rules`, normalised to camelCase. */
export interface AlertRule {
  id: string;
  scope: RunnerAlertScope;
  hostId: string | null;
  pool: string | null;
  metric: string;
  comparison: RunnerAlertComparison;
  threshold: number;
  durationSeconds: number;
  severity: RunnerAlertSeverity;
  channel: string;
  enabled: boolean;
}

/** One stored `runner_metrics` sample (plus the live sample for the current evaluation). */
export interface MetricsSample {
  capturedAt: string;
  metrics: RunnerMetrics;
}

/** The host fields the evaluators need; `RunnerHostRecord` satisfies this structurally. */
export interface HostAlertSubject {
  id: string;
  pool: string;
  lastHeartbeat: string | null;
  enrolledAt?: string | null;
}

export interface AlertEvaluation {
  ruleId: string;
  metric: string;
  severity: RunnerAlertSeverity;
  /** True when the rule's condition currently holds. */
  firing: boolean;
  /** Observed value (null when the metric is absent from the sample). */
  value: number | null;
  message: string;
}

function comparisonSymbol(comparison: RunnerAlertComparison): string {
  return comparison === 'gt' ? '>' : '<';
}

function compare(value: number, comparison: RunnerAlertComparison, threshold: number): boolean {
  return comparison === 'gt' ? value > threshold : value < threshold;
}

function maxOf(values: number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}

function minOf(values: number[]): number | null {
  return values.length > 0 ? Math.min(...values) : null;
}

/**
 * Reads one metric from a sample. Unknown metrics and metrics a host cannot report (e.g.
 * inode usage on a filesystem that does not expose it) return `null`, which never fires.
 */
export function metricValue(metric: string, sample: RunnerMetrics): number | null {
  switch (metric) {
    case 'cpu_percent':
      return sample.cpuPercent ?? null;
    case 'memory_used_percent':
      return sample.memoryUsedPercent ?? null;
    case 'disk_used_percent':
      return maxOf((sample.disks ?? []).map((disk) => disk.usedPercent));
    case 'disk_free_bytes':
      return minOf((sample.disks ?? []).map((disk) => disk.freeBytes));
    case 'inode_used_percent':
      return maxOf(
        (sample.disks ?? [])
          .map((disk) => disk.inodeUsedPercent)
          .filter((value): value is number => typeof value === 'number'),
      );
    case 'queue_wait_seconds':
      return typeof sample.queueWaitMs === 'number' ? sample.queueWaitMs / 1000 : null;
    default:
      // `heartbeat_age_seconds` is evaluated by `evaluateHeartbeatRule`, not from metrics.
      return null;
  }
}

/** Global rules apply everywhere; pool rules to a pool; host rules to one host. */
export function ruleAppliesToHost(rule: AlertRule, host: HostAlertSubject): boolean {
  if (!rule.enabled) return false;
  if (rule.scope === 'host') return rule.hostId !== null && rule.hostId === host.id;
  if (rule.scope === 'pool') return rule.pool !== null && rule.pool === host.pool;
  return true;
}

function buildMessage(
  rule: AlertRule,
  value: number | null,
  firing: boolean,
  suffix: string,
): string {
  const observed = value === null ? 'no data' : String(value);
  const condition = `${rule.metric} ${comparisonSymbol(rule.comparison)} ${rule.threshold}`;
  return firing
    ? `${condition} (observed ${observed})${suffix}`
    : `${rule.metric} recovered (observed ${observed})`;
}

/**
 * Threshold + duration evaluation.
 *
 * - `duration_seconds = 0` checks the latest sample only.
 * - `duration_seconds > 0` requires **every** stored sample inside the window
 *   `[latest - duration, latest]` to breach, and at least one sample to exist. Using the
 *   latest sample's timestamp (instead of wall clock) keeps the evaluator deterministic in
 *   tests and immune to clock skew between host and control plane.
 */
export function evaluateMetricRules(input: {
  host: HostAlertSubject;
  metrics: RunnerMetrics;
  rules: AlertRule[];
  history?: MetricsSample[];
}): AlertEvaluation[] {
  const { host, metrics, rules, history = [] } = input;
  const nowMs = Date.parse(metrics.capturedAt);
  const evaluations: AlertEvaluation[] = [];

  for (const rule of rules) {
    if (rule.metric === 'heartbeat_age_seconds') continue;
    if (!ruleAppliesToHost(rule, host)) continue;

    const current = metricValue(rule.metric, metrics);
    let firing = false;
    let value = current;

    if (current !== null) {
      if (rule.durationSeconds <= 0) {
        firing = compare(current, rule.comparison, rule.threshold);
      } else {
        const windowMs = rule.durationSeconds * 1000;
        const windowStart = Number.isFinite(nowMs) ? nowMs - windowMs : null;
        const inWindow = history.filter((sample) => {
          const at = Date.parse(sample.capturedAt);
          if (!Number.isFinite(at)) return false;
          return windowStart === null || at >= windowStart;
        });
        // The live sample is part of the window; history only supplies the earlier evidence.
        const window = [{ capturedAt: metrics.capturedAt, metrics }, ...inWindow];
        firing =
          inWindow.length > 0 &&
          window.every((sample) => {
            const observed = metricValue(rule.metric, sample.metrics);
            return observed !== null && compare(observed, rule.comparison, rule.threshold);
          });
        // Report the worst value in the window so the alert message is actionable.
        const observed = window
          .map((sample) => metricValue(rule.metric, sample.metrics))
          .filter((entry): entry is number => entry !== null);
        if (observed.length > 0) {
          value = rule.comparison === 'gt' ? Math.max(...observed) : Math.min(...observed);
        }
      }
    }

    const suffix = rule.durationSeconds > 0 ? ` for ${rule.durationSeconds}s` : '';
    evaluations.push({
      ruleId: rule.id,
      metric: rule.metric,
      severity: rule.severity,
      firing,
      value,
      message: buildMessage(rule, value, firing, suffix),
    });
  }

  return evaluations;
}

/**
 * `heartbeat_age_seconds` evaluation, run by the worker loop for hosts whose last heartbeat
 * is stale. A host that has never heartbeated falls back to `enrolledAt`; with neither, the
 * age is treated as infinite so a host stuck in `pending` still alerts.
 */
export function evaluateHeartbeatRule(input: {
  host: HostAlertSubject;
  now: number | Date;
  rules: AlertRule[];
}): AlertEvaluation[] {
  const { host, rules } = input;
  const nowMs = typeof input.now === 'number' ? input.now : input.now.getTime();
  const last = host.lastHeartbeat ?? host.enrolledAt ?? null;
  const lastMs = last ? Date.parse(last) : Number.NaN;
  const ageSeconds = Number.isFinite(lastMs) ? Math.max(0, (nowMs - lastMs) / 1000) : Number.POSITIVE_INFINITY;

  const evaluations: AlertEvaluation[] = [];
  for (const rule of rules) {
    if (rule.metric !== 'heartbeat_age_seconds') continue;
    if (!ruleAppliesToHost(rule, host)) continue;

    const firing = compare(ageSeconds, rule.comparison, rule.threshold);
    evaluations.push({
      ruleId: rule.id,
      metric: rule.metric,
      severity: rule.severity,
      firing,
      value: Number.isFinite(ageSeconds) ? ageSeconds : null,
      message: firing
        ? `heartbeat is ${Number.isFinite(ageSeconds) ? `${Math.round(ageSeconds)}s` : 'missing'} old (${comparisonSymbol(rule.comparison)} ${rule.threshold}s)`
        : 'heartbeat recovered',
    });
  }
  return evaluations;
}

/** `hostId:ruleId` — the dedupe key the DB upsert uses (unique while unresolved). */
export function alertDedupeKey(hostId: string, ruleId: string): string {
  return `${hostId}:${ruleId}`;
}
