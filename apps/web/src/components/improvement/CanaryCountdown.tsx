'use client';

import { useEffect, useState } from 'react';

/**
 * Live observation-window countdown. The server renders `remainingMs`; the browser ticks
 * it down so the operator can see when promotion becomes automatic. It never invents
 * state: at zero it says the window elapsed and the workflow decides.
 */
export function CanaryCountdown({
  endsAt,
  initialRemainingMs,
  active,
}: {
  endsAt: string | null;
  initialRemainingMs: number;
  active: boolean;
}) {
  const [remaining, setRemaining] = useState(initialRemainingMs);

  useEffect(() => {
    if (!active || !endsAt) return undefined;
    const target = Date.parse(endsAt);
    if (!Number.isFinite(target)) return undefined;
    const tick = (): void => setRemaining(Math.max(0, target - Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active, endsAt]);

  const total = Math.max(0, Math.floor(remaining / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const label =
    hours > 0
      ? `${hours}h ${String(minutes).padStart(2, '0')}m`
      : minutes > 0
        ? `${minutes}m ${String(seconds).padStart(2, '0')}s`
        : `${seconds}s`;

  return (
    <span data-testid="canary-window-countdown" data-remaining-ms={remaining} className="font-mono">
      {active ? (remaining > 0 ? label : 'window elapsed') : 'closed'}
    </span>
  );
}
