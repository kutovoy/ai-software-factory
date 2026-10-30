import { formatRate } from '@/lib/improvement';
import type { CanarySeriesBucketWire, CanarySeriesWire } from '@/lib/types';

/**
 * Hourly canary series (harden-runtime, task 5.4).
 *
 * The series is derived from scores/runs; a bucket with no runs is `null` with a reason and
 * is drawn as a gap, never as 0%. The table below the chart exposes the exact values so the
 * chart is not the only source of truth.
 */

const WIDTH = 640;
const HEIGHT = 150;
const PAD_X = 28;
const PAD_Y = 12;

function segments(buckets: CanarySeriesBucketWire[]): { index: number; value: number }[][] {
  const result: { index: number; value: number }[][] = [];
  let current: { index: number; value: number }[] = [];
  for (const [index, bucket] of buckets.entries()) {
    if (bucket.passRate === null) {
      if (current.length > 0) result.push(current);
      current = [];
      continue;
    }
    current.push({ index, value: bucket.passRate });
  }
  if (current.length > 0) result.push(current);
  return result;
}

function points(bucketCount: number, values: { index: number; value: number }[]): string {
  const step = bucketCount > 1 ? (WIDTH - PAD_X * 2) / (bucketCount - 1) : 0;
  return values
    .map(({ index, value }) => {
      const x = PAD_X + index * step;
      const y = PAD_Y + (1 - Math.max(0, Math.min(1, value))) * (HEIGHT - PAD_Y * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function CanarySeriesChart({ series }: { series: CanarySeriesWire | null }) {
  if (!series) {
    return (
      <p data-testid="canary-series-empty" className="text-xs text-slate-500">
        No hourly series is available for this rollout yet.
      </p>
    );
  }

  const buckets = series.candidate.length > 0 ? series.candidate : series.stable;
  const count = Math.max(series.stable.length, series.candidate.length);
  const stableSegments = segments(series.stable);
  const candidateSegments = segments(series.candidate);
  const empty = [...series.stable, ...series.candidate].every((bucket) => bucket.runs === 0);

  return (
    <div data-testid="canary-series" data-bucket-hours={series.bucketHours} data-empty={empty ? 'true' : 'false'}>
      <svg
        data-testid="canary-series-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Hourly pass rate per version; missing buckets are gaps"
        className="h-36 w-full rounded border border-slate-200 bg-white"
      >
        <line x1={PAD_X} y1={PAD_Y} x2={WIDTH - PAD_X} y2={PAD_Y} stroke="#e2e8f0" />
        <line
          x1={PAD_X}
          y1={PAD_Y + (HEIGHT - PAD_Y * 2) / 2}
          x2={WIDTH - PAD_X}
          y2={PAD_Y + (HEIGHT - PAD_Y * 2) / 2}
          stroke="#e2e8f0"
        />
        <line
          x1={PAD_X}
          y1={HEIGHT - PAD_Y}
          x2={WIDTH - PAD_X}
          y2={HEIGHT - PAD_Y}
          stroke="#e2e8f0"
        />
        {stableSegments.map((segment, index) => (
          <polyline
            key={`stable-${index}`}
            data-testid="canary-series-line-stable"
            points={points(count, segment)}
            fill="none"
            stroke="#64748b"
            strokeWidth="2"
          />
        ))}
        {candidateSegments.map((segment, index) => (
          <polyline
            key={`candidate-${index}`}
            data-testid="canary-series-line-candidate"
            points={points(count, segment)}
            fill="none"
            stroke="#0284c7"
            strokeWidth="2"
          />
        ))}
      </svg>

      <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-slate-600">
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-slate-500" /> stable
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-sky-600" /> candidate
        </span>
        <span className="text-slate-400">
          hourly buckets {series.from.slice(0, 16)} → {series.to.slice(0, 16)} · gaps are empty
          buckets, not 0%
        </span>
      </div>

      <ul data-testid="canary-series-buckets" className="mt-1 flex flex-wrap gap-1">
        {buckets.map((bucket) => (
          <li
            key={`${bucket.version}-${bucket.bucketStart}`}
            data-testid="canary-series-bucket"
            data-version={bucket.version}
            data-bucket-start={bucket.bucketStart}
            data-pass-rate={bucket.passRate === null ? '' : String(bucket.passRate)}
            data-reason={bucket.reason ?? ''}
            className="rounded border border-slate-200 px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
          >
            {bucket.bucketStart.slice(11, 16)} · {formatRate(bucket.passRate)} · {bucket.runs} run
            {bucket.runs === 1 ? '' : 's'}
            {bucket.reason ? ` (${bucket.reason})` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
