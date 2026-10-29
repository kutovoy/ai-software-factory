'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Syncs Temporal schedules from the definition (spec `automations` › scheduled automations):
 * an enabled automation gets an active schedule, a disabled one is paused.
 */
export function AutomationSyncButton({ factory }: { factory: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sync = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/automations/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ factory }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        created?: string[];
        paused?: string[];
        message?: string;
      };
      if (!response.ok) throw new Error(payload.message ?? `request failed (${response.status})`);
      setNotice(
        `Schedules synced — ${payload.created?.length ?? 0} created, ${payload.paused?.length ?? 0} paused.`,
      );
      router.refresh();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        data-testid="automations-sync"
        onClick={() => void sync()}
        disabled={busy}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-800 disabled:opacity-50"
      >
        {busy ? 'Syncing…' : 'Sync schedules'}
      </button>
      {error ? (
        <span data-testid="automations-sync-error" className="text-[11px] text-red-700">
          {error}
        </span>
      ) : null}
      {notice ? (
        <span data-testid="automations-sync-notice" className="text-[11px] text-emerald-700">
          {notice}
        </span>
      ) : null}
    </div>
  );
}
