import {
  DEFAULT_REVIEW_CAPACITY,
  type ComprehensionMetrics,
  type ResolvedReviewCapacity,
  type ReviewCapacityStatus,
} from './types';

/**
 * Review capacity: the factory-level attention budget (change
 * `add-review-capacity-and-compounding`).
 *
 * Pure data in, deterministic status out: no model, no shell, no Node APIs. The
 * orchestration layer feeds pending gates and unread diff volume in; this module only
 * resolves caps and reports whether they are exceeded.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function pickNumber(value: unknown, fallback: number, integer: boolean): number {
  if (!isFiniteNumber(value) || value < 0) return fallback;
  return integer ? Math.floor(value) : value;
}

function display(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

/**
 * Merges an optional/partial capacity config with the shipped defaults. Accepts both a
 * bare `ReviewCapacityConfig` and a full `QualityConfig` (`{ reviewCapacity: {...} }`).
 */
export function resolveReviewCapacity(
  value: unknown | null | undefined,
): ResolvedReviewCapacity {
  const source = isRecord(value) ? value : {};
  const caps = isRecord(source.reviewCapacity) ? source.reviewCapacity : source;
  return {
    maxOpenGates: pickNumber(
      caps.maxOpenGates,
      DEFAULT_REVIEW_CAPACITY.maxOpenGates,
      true,
    ),
    maxUnreadDiffLines: pickNumber(
      caps.maxUnreadDiffLines,
      DEFAULT_REVIEW_CAPACITY.maxUnreadDiffLines,
      true,
    ),
    maxGateAgeHours: pickNumber(
      caps.maxGateAgeHours,
      DEFAULT_REVIEW_CAPACITY.maxGateAgeHours,
      false,
    ),
    maxReviewHoursPerWeek: pickNumber(
      caps.maxReviewHoursPerWeek,
      DEFAULT_REVIEW_CAPACITY.maxReviewHoursPerWeek,
      false,
    ),
  };
}

/**
 * Compares the factory's current review pressure with its caps. `saturated` is true when
 * any cap is exceeded; `reasons` names each exceeded cap in a stable order. A missing
 * `reviewHoursPerWeek` measurement is never treated as zero pressure (it is simply not
 * checked).
 */
export function evaluateReviewCapacity(
  input: {
    openGates: number;
    unreadDiffLines: number;
    oldestGateHours: number;
    reviewHoursPerWeek?: number;
  },
  config: ResolvedReviewCapacity,
): ReviewCapacityStatus {
  const openGates = isFiniteNumber(input.openGates) && input.openGates >= 0 ? Math.floor(input.openGates) : 0;
  const unreadDiffLines =
    isFiniteNumber(input.unreadDiffLines) && input.unreadDiffLines >= 0
      ? Math.floor(input.unreadDiffLines)
      : 0;
  const oldestGateHours =
    isFiniteNumber(input.oldestGateHours) && input.oldestGateHours >= 0
      ? input.oldestGateHours
      : 0;

  const reasons: string[] = [];

  if (openGates > config.maxOpenGates) {
    reasons.push(`open gates ${display(openGates)} > ${display(config.maxOpenGates)}`);
  }
  if (unreadDiffLines > config.maxUnreadDiffLines) {
    reasons.push(
      `unread diff lines ${display(unreadDiffLines)} > ${display(config.maxUnreadDiffLines)}`,
    );
  }
  if (oldestGateHours > config.maxGateAgeHours) {
    reasons.push(`oldest gate ${display(oldestGateHours)}h > ${display(config.maxGateAgeHours)}h`);
  }
  if (
    isFiniteNumber(input.reviewHoursPerWeek) &&
    input.reviewHoursPerWeek > config.maxReviewHoursPerWeek
  ) {
    reasons.push(
      `review hours ${display(input.reviewHoursPerWeek)} > ${display(config.maxReviewHoursPerWeek)}`,
    );
  }

  return {
    saturated: reasons.length > 0,
    openGates,
    unreadDiffLines,
    oldestGateHours,
    reasons,
  };
}

/** The stable zeroes a projection returns when a factory has no review work yet. */
export function emptyComprehensionMetrics(): ComprehensionMetrics {
  return {
    unreadDiffLines: 0,
    itemsWithoutHumanReview: 0,
    modulesWithoutHumanTouch: 0,
    reviewCoveragePercent: 0,
  };
}
