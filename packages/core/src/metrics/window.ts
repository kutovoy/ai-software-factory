/**
 * Metrics windows. Metrics are derived queries (ADR-017), so every request names a
 * window and the response echoes the exact bounds it was computed over.
 */

export interface MetricsWindow {
  /** ISO timestamp, inclusive. */
  from: string;
  /** ISO timestamp, exclusive-ish (the request time). */
  to: string;
  days: number;
  label: string;
}

export class MetricsWindowError extends Error {
  readonly code = 'invalid_window';

  constructor(message: string) {
    super(message);
    this.name = 'MetricsWindowError';
  }
}

const WINDOW_RE = /^(\d{1,3})([dhw])$/;

/** Accepts `7d`, `30d`, `12w`, `24h`; defaults to 30 days. */
export function parseMetricsWindow(
  input: string | null | undefined,
  now: Date = new Date(),
): MetricsWindow {
  const label = (input ?? '30d').trim().toLowerCase();
  const match = WINDOW_RE.exec(label);
  if (!match) {
    throw new MetricsWindowError(
      `invalid window "${input ?? ''}"; expected <n>d, <n>w or <n>h (e.g. 30d)`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const days = unit === 'd' ? amount : unit === 'w' ? amount * 7 : amount / 24;
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    throw new MetricsWindowError('window must be between 1 hour and 365 days');
  }
  const to = now.getTime();
  const from = to - days * 24 * 60 * 60 * 1000;
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    days,
    label,
  };
}
