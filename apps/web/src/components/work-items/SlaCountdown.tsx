'use client';

import { useEffect, useState } from 'react';
import { humanizeSeconds } from '@/lib/work-items';

/**
 * Live SLA countdown for a pending gate.
 *
 * The first render is deliberately time-independent ("…") so SSR and hydration agree; the
 * client then ticks the value every 30s so a page left open does not show a stale deadline.
 */
export function SlaCountdown({ slaAt, testId = 'sla-countdown' }: { slaAt: string | null; testId?: string }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!slaAt || Number.isNaN(Date.parse(slaAt))) {
    return (
      <span data-testid={testId} data-overdue="false" className="font-mono text-[11px] text-slate-500">
        no SLA
      </span>
    );
  }

  if (now === null) {
    return (
      <span
        data-testid={testId}
        data-overdue="false"
        data-sla-at={slaAt}
        className="font-mono text-[11px] text-slate-500"
      >
        …
      </span>
    );
  }

  const secondsRemaining = Math.round((Date.parse(slaAt) - now) / 1000);
  const overdue = secondsRemaining < 0;

  return (
    <span
      data-testid={testId}
      data-overdue={overdue ? 'true' : 'false'}
      data-sla-at={slaAt}
      className={`font-mono text-[11px] ${overdue ? 'text-red-700' : 'text-slate-500'}`}
    >
      {humanizeSeconds(secondsRemaining)}
    </span>
  );
}
