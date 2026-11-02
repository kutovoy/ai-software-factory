'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Starts one on-demand improvement run (eligibility → observe → probe → compose → decide). */
export function ImprovementRunButton({ factoryId }: { factoryId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setError(null);
    setStarted(null);
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/factories/${encodeURIComponent(factoryId)}/improvement/run`,
        {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trigger: 'on_demand' }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
        improvement?: { id: string };
      };
      if (!response.ok) {
        throw new Error(payload.message ?? payload.code ?? `improvement run failed (${response.status})`);
      }
      setStarted(payload.improvement?.id ?? 'started');
      router.refresh();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        data-testid="improvement-run"
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Starting…' : 'Run improvement now'}
      </button>
      {started ? (
        <span data-testid="improvement-run-started" className="text-xs text-emerald-800">
          Started {started}
        </span>
      ) : null}
      {error ? (
        <span data-testid="improvement-run-error" className="text-xs text-red-700">
          {error}
        </span>
      ) : null}
    </div>
  );
}
