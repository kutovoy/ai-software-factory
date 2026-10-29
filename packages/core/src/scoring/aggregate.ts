import type { ScoreAggregate, ScoreAggregateRow } from './types';

/**
 * Pure aggregation over score rows. Kept free of SQL so the API tests can prove the
 * arithmetic (weighted pass rate, sample counts, benchmark eligibility) without a DB.
 */
export function aggregateScoreRows(rows: ScoreAggregateRow[]): ScoreAggregate[] {
  const byScorer = new Map<string, ScoreAggregateRow[]>();
  for (const row of rows) {
    const bucket = byScorer.get(row.scorer);
    if (bucket) bucket.push(row);
    else byScorer.set(row.scorer, [row]);
  }

  const aggregates: ScoreAggregate[] = [];
  for (const [scorer, samples] of byScorer) {
    const ok = samples.filter((row) => row.status === 'ok');
    const scored = ok.filter((row) => row.score !== null);
    const passing = ok.filter((row) => row.passing).length;
    const uncalibrated = ok.filter((row) => row.uncalibrated).length;
    const costUsd = samples.reduce((total, row) => total + (row.costUsd ?? 0), 0);
    const scorerClass = samples[0]?.scorerClass ?? 'judge';

    aggregates.push({
      scorer,
      scorerClass,
      sampleCount: ok.length,
      passingCount: passing,
      passRate: ok.length === 0 ? null : passing / ok.length,
      weightedScore:
        scored.length === 0
          ? null
          : scored.reduce((total, row) => total + (row.score ?? 0), 0) / scored.length,
      errorCount: samples.filter((row) => row.status === 'error').length,
      skippedCount: samples.filter((row) => row.status === 'skipped').length,
      uncalibratedCount: uncalibrated,
      costUsd,
      benchmarkEligible:
        scorerClass === 'deterministic' ? ok.length > 0 : ok.length > 0 && uncalibrated === 0,
    });
  }

  return aggregates.sort((left, right) => left.scorer.localeCompare(right.scorer));
}
