import type {
  CalibrationComputation,
  CalibrationItemObservation,
  CalibrationResultLike,
} from './types';

/**
 * Judge calibration against a human-labelled golden set.
 *
 * Reports exact agreement, within-tolerance agreement (score distance), a per-label
 * confusion matrix and a pass/fail verdict against a threshold. Below the configured
 * minimum sample size it refuses to certify: `insufficient_data`, never a lucky pass on
 * three examples.
 */

export interface CalibrationOptions {
  minSize?: number;
  threshold?: number;
  /** Absolute score distance still counted as agreement. */
  tolerance?: number;
}

export const DEFAULT_CALIBRATION_MIN_SIZE = 20;
export const DEFAULT_CALIBRATION_THRESHOLD = 0.8;
export const DEFAULT_CALIBRATION_TOLERANCE = 0.25;

export function computeCalibration(
  items: CalibrationItemObservation[],
  options: CalibrationOptions = {},
): CalibrationComputation {
  const minSize = Math.max(1, Math.trunc(options.minSize ?? DEFAULT_CALIBRATION_MIN_SIZE));
  const threshold = clamp(options.threshold ?? DEFAULT_CALIBRATION_THRESHOLD);
  const tolerance = clamp(options.tolerance ?? DEFAULT_CALIBRATION_TOLERANCE);
  const sampleSize = items.length;

  const confusion: Record<string, Record<string, number>> = {};
  let exact = 0;
  let within = 0;

  for (const item of items) {
    const judgeLabel = item.judgeLabel ?? 'unknown';
    confusion[item.humanLabel] ??= {};
    confusion[item.humanLabel]![judgeLabel] = (confusion[item.humanLabel]![judgeLabel] ?? 0) + 1;

    if (item.judgeLabel === item.humanLabel) exact += 1;
    if (item.judgeScore !== null && Math.abs(item.humanScore - item.judgeScore) <= tolerance) {
      within += 1;
    }
  }

  if (sampleSize < minSize) {
    return {
      status: 'insufficient_data',
      verdict: 'insufficient_data',
      sampleSize,
      minSize,
      agreementExact: null,
      agreementWithinTolerance: null,
      tolerance,
      threshold,
      confusion,
      reason: `golden set has ${sampleSize} item(s); calibration needs at least ${minSize}`,
    };
  }

  const agreementExact = exact / sampleSize;
  const agreementWithinTolerance = within / sampleSize;
  return {
    status: 'ok',
    verdict: agreementExact >= threshold ? 'pass' : 'fail',
    sampleSize,
    minSize,
    agreementExact,
    agreementWithinTolerance,
    tolerance,
    threshold,
    confusion,
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A judge is calibrated only by a *passing* result for its current rubric + model. */
export function isCalibrated(
  results: CalibrationResultLike[],
  rubricHash: string,
  judgeModel: string,
): boolean {
  return results.some(
    (result) =>
      result.rubricHash === rubricHash &&
      result.judgeModel === judgeModel &&
      result.verdict === 'pass',
  );
}

export function calibrationSummary(computation: CalibrationComputation): string {
  if (computation.status === 'insufficient_data') {
    return `insufficient_data: ${computation.reason ?? 'not enough examples'}`;
  }
  return `${computation.verdict}: exact agreement ${(computation.agreementExact ?? 0).toFixed(2)} (threshold ${computation.threshold})`;
}
