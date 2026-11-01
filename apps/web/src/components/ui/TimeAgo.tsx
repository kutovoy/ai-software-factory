'use client';

import { useEffect, useState } from 'react';
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format';

/**
 * Hydration-safe time rendering (spec `web-console`; harden-runners task 3).
 *
 * A relative label (`3m ago`) or a live duration depends on `Date.now()`, so the server and
 * the browser can disagree when they render at different instants — React then logs a
 * hydration mismatch (#418). The first render is therefore deterministic: the absolute ISO
 * timestamp, which is a pure function of the stored value. The relative label is applied
 * only after mount, so SSR and hydration always agree.
 */

export function TimeAgo({
  value,
  prefix = '',
  testId,
  className,
}: {
  value: string | null | undefined;
  /** Text before the label, e.g. `created `. */
  prefix?: string;
  testId?: string;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const absolute = formatDateTime(value);
  const label = mounted ? formatRelative(value) : absolute;

  return (
    <span
      data-testid={testId}
      className={className}
      title={absolute}
      suppressHydrationWarning
    >
      {prefix}
      {label}
    </span>
  );
}

export function ElapsedTime({
  startedAt,
  endedAt,
}: {
  startedAt: string | null;
  endedAt: string | null;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Deterministic first render: the ISO start time. A running run's elapsed value is
  // computed from `Date.now()` after mount only.
  return (
    <span suppressHydrationWarning>
      {mounted ? formatDuration(startedAt, endedAt) : formatDateTime(startedAt)}
    </span>
  );
}
