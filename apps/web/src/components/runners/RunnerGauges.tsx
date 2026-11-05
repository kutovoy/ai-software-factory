import type { Tone } from '@/components/ui/Badge';
import type {
  RunnerAlertSeverityWire,
  RunnerAlertStateWire,
  RunnerHostStatusWire,
  RunnerLabelsWire,
} from '@/lib/types';

/**
 * Presentational helpers for the Runners console surface. No hooks and no `'use client'`,
 * so both the server-rendered detail page and the client panel can use them.
 *
 * Every gauge is a projection of the last heartbeat sample: a missing value renders as
 * `—` with an empty bar rather than a fabricated zero (the console's "empty means empty"
 * rule). Threshold colours are advisory — the alert rules, not the colour, decide.
 */

/** Percent (0–100) or `—` when the agent has not reported the metric yet. */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}%`;
}

/** `—` for a null metric; a fixed 2-decimal number otherwise. */
export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function clampPercent(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function barTone(value: number | null | undefined): string {
  const percent = clampPercent(value);
  if (value === null || value === undefined) return 'bg-slate-200';
  if (percent >= 90) return 'bg-red-500';
  if (percent >= 80) return 'bg-amber-500';
  return 'bg-emerald-500';
}

/**
 * A labelled usage bar. `value` is a percentage; the bar keeps its track visible so a
 * missing sample reads as "nothing reported", not "0% used".
 */
export function Meter({
  label,
  value,
  testId,
  compact = false,
}: {
  label: string;
  value: number | null | undefined;
  testId?: string;
  compact?: boolean;
}) {
  const known = value !== null && value !== undefined && Number.isFinite(value);
  return (
    <div
      data-testid={testId}
      data-metric={label.toLowerCase()}
      data-value={known ? String(Math.round(value)) : ''}
      className={compact ? 'min-w-[72px] space-y-0.5' : 'space-y-1'}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={compact ? 'text-[10px] uppercase tracking-wide text-slate-400' : 'text-xs uppercase tracking-wide text-slate-400'}>
          {label}
        </span>
        <span className={compact ? 'font-mono text-[11px] text-slate-700' : 'font-mono text-xs text-slate-700'}>
          {formatPercent(value)}
        </span>
      </div>
      <div
        className={`w-full overflow-hidden rounded-full bg-slate-100 ${compact ? 'h-1' : 'h-1.5'}`}
        role="img"
        aria-label={`${label} ${formatPercent(value)}`}
      >
        <div
          className={`h-full rounded-full ${barTone(value)}`}
          style={{ width: `${known ? clampPercent(value) : 0}%` }}
        />
      </div>
    </div>
  );
}

/**
 * A tiny inline trend line over the stored samples (oldest → newest). `values` must be
 * finite numbers; callers filter null samples first so a gap never becomes a zero.
 */
export function Sparkline({
  values,
  testId,
  label,
}: {
  values: number[];
  testId?: string;
  label: string;
}) {
  if (values.length < 2) {
    return (
      <p data-testid={testId} className="text-[11px] text-slate-400">
        {values.length === 1 ? 'one sample — no trend yet' : 'no samples in the window'}
      </p>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = span === 0 ? 16 : 28 - ((value - min) / span) * 24;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg
      data-testid={testId}
      data-points={values.length}
      role="img"
      aria-label={`${label} trend, ${values.length} samples, ${Math.round(min)}%–${Math.round(max)}%`}
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      className="h-8 w-full text-sky-500"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Status badge tone. Only `ready` is schedulable; `unreachable`/`error` are bad news. */
export function hostStatusTone(status: RunnerHostStatusWire | string): Tone {
  switch (status) {
    case 'ready':
      return 'success';
    case 'pending':
    case 'provisioning':
    case 'initializing':
      return 'info';
    case 'maintenance':
    case 'not_ready':
      return 'warning';
    case 'unreachable':
    case 'error':
    case 'deleting':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function alertSeverityTone(severity: RunnerAlertSeverityWire | string): Tone {
  return severity === 'critical' ? 'danger' : 'warning';
}

export function alertStateTone(state: RunnerAlertStateWire | string): Tone {
  switch (state) {
    case 'firing':
      return 'danger';
    case 'acknowledged':
      return 'warning';
    case 'silenced':
      return 'info';
    case 'resolved':
      return 'success';
    default:
      return 'neutral';
  }
}

export function leaseStateTone(state: string): Tone {
  switch (state) {
    case 'active':
      return 'info';
    case 'released':
      return 'success';
    case 'expired':
      return 'warning';
    case 'error':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** `{k: v}` → `['k=v', …]`, sorted so the table column does not reorder between renders. */
export function labelPairs(labels: RunnerLabelsWire | null | undefined): string[] {
  if (!labels || typeof labels !== 'object') return [];
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${String(value)}`)
    .sort();
}

/** Rules print as `cpu_percent > 85 for 300s`. */
export function ruleCondition(rule: {
  metric: string;
  comparison: string;
  threshold: number;
  durationSeconds: number;
}): string {
  const symbol = rule.comparison === 'lt' ? '<' : '>';
  const duration = rule.durationSeconds > 0 ? ` for ${rule.durationSeconds}s` : '';
  return `${rule.metric} ${symbol} ${rule.threshold}${duration}`;
}
