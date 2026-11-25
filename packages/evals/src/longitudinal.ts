/**
 * Longitudinal quality evaluation (change `add-review-capacity-and-compounding`).
 *
 * Deterministic, model-free comparison of a candidate codebase checkpoint against a
 * baseline across the metrics the factory already measures. A missing metric is reported
 * as `unknown` — it is never treated as zero. The result can gate autonomy: a regression
 * is a reason to keep a human in the loop.
 */

/** One checkpoint's measured quality metrics; `null`/absent means not measured. */
export interface LongitudinalMetrics {
  duplicationPercent?: number | null;
  cyclomaticComplexity?: number | null;
  linesPerSymbol?: number | null;
  dependencyCount?: number | null;
  churnPercent?: number | null;
  reworkRate?: number | null;
  medianReviewMinutes?: number | null;
  changeFailureRate?: number | null;
  publicApiChanges?: number | null;
  schemaChanges?: number | null;
}

/**
 * Allowed worsening per metric. Percentage limits are relative to the baseline (an
 * absolute fallback applies when the baseline is zero); the rest are absolute.
 */
export interface LongitudinalThresholds {
  maxDuplicationIncreasePercent: number;
  maxComplexityIncreasePercent: number;
  maxDependencyIncrease: number;
  maxChurnIncreasePercent: number;
  maxReworkIncreasePercent: number;
  maxReviewTimeIncreasePercent: number;
  maxChangeFailureIncreasePercent: number;
  /** Shared absolute cap for public API and schema surface changes. */
  maxPublicApiChanges: number;
}

/** Generous defaults: catch real drift without failing on normal noise. */
export const DEFAULT_LONGITUDINAL_THRESHOLDS: LongitudinalThresholds = {
  maxDuplicationIncreasePercent: 25,
  maxComplexityIncreasePercent: 20,
  maxDependencyIncrease: 5,
  maxChurnIncreasePercent: 30,
  maxReworkIncreasePercent: 25,
  maxReviewTimeIncreasePercent: 50,
  maxChangeFailureIncreasePercent: 25,
  maxPublicApiChanges: 10,
};

export interface LongitudinalRegression {
  metric: string;
  baseline: number;
  candidate: number;
  limit: number;
}

export interface LongitudinalImprovement {
  metric: string;
  baseline: number;
  candidate: number;
}

export interface LongitudinalComparison {
  status: 'improved' | 'regression' | 'unchanged' | 'unknown';
  regressions: LongitudinalRegression[];
  improvements: LongitudinalImprovement[];
  /** Metrics that were missing on either side; never silently treated as zero. */
  unknown: string[];
}

/** Stable metric order so the comparison is deterministic. */
const METRIC_ORDER = [
  'duplicationPercent',
  'cyclomaticComplexity',
  'linesPerSymbol',
  'dependencyCount',
  'churnPercent',
  'reworkRate',
  'medianReviewMinutes',
  'changeFailureRate',
  'publicApiChanges',
  'schemaChanges',
] as const;

type MetricKey = (typeof METRIC_ORDER)[number];

interface PercentRule {
  metric: MetricKey;
  threshold: keyof LongitudinalThresholds;
}

interface AbsoluteRule {
  metric: MetricKey;
  threshold: keyof LongitudinalThresholds;
  /** `delta` compares candidate - baseline; `cap` compares candidate against the limit. */
  kind: 'delta' | 'cap';
}

const PERCENT_RULES: PercentRule[] = [
  { metric: 'duplicationPercent', threshold: 'maxDuplicationIncreasePercent' },
  { metric: 'cyclomaticComplexity', threshold: 'maxComplexityIncreasePercent' },
  { metric: 'churnPercent', threshold: 'maxChurnIncreasePercent' },
  { metric: 'reworkRate', threshold: 'maxReworkIncreasePercent' },
  { metric: 'medianReviewMinutes', threshold: 'maxReviewTimeIncreasePercent' },
  { metric: 'changeFailureRate', threshold: 'maxChangeFailureIncreasePercent' },
];

const ABSOLUTE_RULES: AbsoluteRule[] = [
  { metric: 'dependencyCount', threshold: 'maxDependencyIncrease', kind: 'delta' },
  { metric: 'publicApiChanges', threshold: 'maxPublicApiChanges', kind: 'cap' },
  { metric: 'schemaChanges', threshold: 'maxPublicApiChanges', kind: 'cap' },
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function read(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function mergeThresholds(
  overrides: Partial<LongitudinalThresholds> | undefined,
): LongitudinalThresholds {
  const merged: LongitudinalThresholds = { ...DEFAULT_LONGITUDINAL_THRESHOLDS };
  if (!overrides) return merged;
  for (const key of Object.keys(DEFAULT_LONGITUDINAL_THRESHOLDS) as Array<
    keyof LongitudinalThresholds
  >) {
    const value = overrides[key];
    if (isFiniteNumber(value) && value >= 0) merged[key] = value;
  }
  return merged;
}

/** Relative increase (%) over the baseline; absolute fallback when baseline is zero. */
function percentIncrease(baseline: number, candidate: number): number {
  if (baseline === 0) return candidate;
  return ((candidate - baseline) / Math.abs(baseline)) * 100;
}

/**
 * Compares a candidate checkpoint against a baseline. Rules:
 *  - a metric missing on either side goes to `unknown` (never zero);
 *  - percent metrics regress when the candidate grows past the allowed percentage;
 *  - absolute metrics regress past their absolute limit (public API/schema are caps);
 *  - any metric that decreases is an improvement;
 *  - `status` prefers regression, then improvement, then unchanged, then unknown.
 */
export function compareLongitudinalQuality(
  baseline: LongitudinalMetrics,
  candidate: LongitudinalMetrics,
  thresholds?: Partial<LongitudinalThresholds>,
): LongitudinalComparison {
  const limits = mergeThresholds(thresholds);
  const regressions: LongitudinalRegression[] = [];
  const improvements: LongitudinalImprovement[] = [];
  const unknown: string[] = [];
  let comparable = 0;

  const percentRules = new Map(PERCENT_RULES.map((rule) => [rule.metric, rule]));
  const absoluteRules = new Map(ABSOLUTE_RULES.map((rule) => [rule.metric, rule]));

  for (const metric of METRIC_ORDER) {
    const before = read(baseline[metric]);
    const after = read(candidate[metric]);
    if (before === null || after === null) {
      unknown.push(metric);
      continue;
    }
    comparable += 1;

    const percentRule = percentRules.get(metric);
    if (percentRule) {
      const limit = limits[percentRule.threshold];
      if (percentIncrease(before, after) > limit) {
        regressions.push({ metric, baseline: before, candidate: after, limit });
      } else if (after < before) {
        improvements.push({ metric, baseline: before, candidate: after });
      }
      continue;
    }

    const absoluteRule = absoluteRules.get(metric);
    if (absoluteRule) {
      const limit = limits[absoluteRule.threshold];
      const exceeded =
        absoluteRule.kind === 'cap' ? after > limit : after - before > limit;
      if (exceeded) {
        regressions.push({ metric, baseline: before, candidate: after, limit });
      } else if (after < before) {
        improvements.push({ metric, baseline: before, candidate: after });
      }
      continue;
    }

    // `linesPerSymbol` has no configured limit; it can only be reported as an improvement.
    if (after < before) {
      improvements.push({ metric, baseline: before, candidate: after });
    }
  }

  let status: LongitudinalComparison['status'];
  if (regressions.length > 0) status = 'regression';
  else if (improvements.length > 0) status = 'improved';
  else if (comparable > 0) status = 'unchanged';
  else status = 'unknown';

  return { status, regressions, improvements, unknown };
}
