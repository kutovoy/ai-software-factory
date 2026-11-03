'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { formatRelative } from '@/lib/format';

/**
 * Shared header control (`web-console` spec: "Auto-refresh"). Server components read the
 * API with `cache: 'no-store'`, so `router.refresh()` re-runs them and the page shows the
 * current projection without a full reload.
 *
 * The interval is persisted in `localStorage`; the first render always uses the default so
 * the server and client markup agree (the stored value is applied after mount). Documentation
 * routes render nothing at all — no control, no timer.
 */

const STORAGE_KEY = 'factory-console.auto-refresh';
const DEFAULT_SECONDS = 15;
const OPTIONS = [
  { seconds: 0, label: 'Off' },
  { seconds: 15, label: '15s' },
  { seconds: 30, label: '30s' },
  { seconds: 60, label: '60s' },
] as const;

function isDocsRoute(pathname: string): boolean {
  return pathname === '/help' || pathname.startsWith('/help/');
}

function storedInterval(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return OPTIONS.some((option) => option.seconds === parsed) ? parsed : DEFAULT_SECONDS;
  } catch {
    return DEFAULT_SECONDS;
  }
}

function updatedLabel(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 10) return 'just now';
  return formatRelative(new Date(at).toISOString());
}

export function AutoRefresh() {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const docs = isDocsRoute(pathname);

  const [intervalSeconds, setIntervalSeconds] = useState<number>(DEFAULT_SECONDS);
  const [updated, setUpdated] = useState<string | null>(null);
  const lastRefresh = useRef<number | null>(null);

  // Hydration-safe: the stored choice is applied only after the first client render.
  useEffect(() => {
    setIntervalSeconds(storedInterval());
  }, []);

  // The refresh timer: skipped while the tab is hidden, and resumes (one immediate refresh)
  // when it becomes visible again.
  useEffect(() => {
    if (docs || intervalSeconds <= 0) return;

    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      router.refresh();
      lastRefresh.current = Date.now();
      setUpdated(updatedLabel(Date.now()));
    };

    const timer = window.setInterval(refresh, intervalSeconds * 1000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [docs, intervalSeconds, router]);

  // Keep "updated <relative>" honest without refreshing.
  useEffect(() => {
    if (docs) return;
    const timer = window.setInterval(() => {
      if (lastRefresh.current !== null) setUpdated(updatedLabel(lastRefresh.current));
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [docs]);

  if (docs) return null;

  return (
    <div
      data-testid="auto-refresh"
      data-interval={String(intervalSeconds)}
      className="flex items-center gap-2 border-l border-slate-800 pl-2"
    >
      <label
        htmlFor="auto-refresh-interval"
        className="text-xs font-medium text-slate-400"
      >
        Auto-refresh
      </label>
      <select
        id="auto-refresh-interval"
        data-testid="auto-refresh-interval"
        aria-label="Auto-refresh interval"
        value={String(intervalSeconds)}
        onChange={(event) => {
          const next = Number.parseInt(event.target.value, 10);
          const value = OPTIONS.some((option) => option.seconds === next) ? next : DEFAULT_SECONDS;
          setIntervalSeconds(value);
          try {
            window.localStorage.setItem(STORAGE_KEY, String(value));
          } catch {
            // private mode / storage disabled: the choice simply does not persist
          }
        }}
        className="rounded-md border border-slate-700 bg-slate-900 px-1.5 py-1 text-xs text-slate-200 focus:border-teal-400 focus:outline-none focus:ring-2 focus:ring-teal-400/20"
      >
        {OPTIONS.map((option) => (
          <option key={option.seconds} value={String(option.seconds)}>
            {option.label}
          </option>
        ))}
      </select>
      <span
        data-testid="auto-refresh-updated"
        className="min-w-[7rem] text-xs text-slate-500"
      >
        {updated === null ? '' : `updated ${updated}`}
      </span>
    </div>
  );
}
