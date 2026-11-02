'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { AUTHORITY_OPTIONS, authorityTone } from '@/lib/improvement';
import type { AuthorityChangeWire, ImprovementResolvedWire } from '@/lib/types';

/**
 * Authority selector (spec `self-improvement` › Authority change).
 *
 * The authority is a definition field, so the console cannot just flip a switch: the API
 * returns the diff first, and only a confirmed request opens a PR against the definition
 * repo. The page never writes the worktree.
 */
export function AuthoritySelector({
  factoryId,
  resolved,
}: {
  factoryId: string;
  resolved: ImprovementResolvedWire;
}) {
  const router = useRouter();
  const [authority, setAuthority] = useState(resolved.authority);
  const [canaryPercent, setCanaryPercent] = useState(
    resolved.canaryPercent === null ? '10' : String(resolved.canaryPercent),
  );
  const [rollbackThreshold, setRollbackThreshold] = useState(
    resolved.rollbackThreshold === null ? '0.1' : String(resolved.rollbackThreshold),
  );
  const [actor, setActor] = useState('local-user');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<AuthorityChangeWire | null>(null);
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const body = (confirm: boolean): Record<string, unknown> => ({
    authority,
    actor: actor.trim(),
    reason: reason.trim(),
    confirm,
    ...(authority === 'canary'
      ? {
          canaryPercent: Number(canaryPercent),
          rollbackThreshold: Number(rollbackThreshold),
        }
      : {}),
  });

  const submit = async (confirm: boolean): Promise<void> => {
    setError(null);
    if (!actor.trim() || !reason.trim()) {
      setError('an actor and a reason are required for every authority change');
      return;
    }
    setBusy(confirm ? 'confirm' : 'preview');
    try {
      const response = await fetch(
        `/api/v1/factories/${encodeURIComponent(factoryId)}/improvement/authority`,
        {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body(confirm)),
      });
      const payload = (await response.json().catch(() => ({}))) as AuthorityChangeWire & {
        message?: string;
        code?: string;
      };
      if (!response.ok) {
        throw new Error(payload.message ?? payload.code ?? `authority change failed (${response.status})`);
      }
      setPreview(payload);
      if (confirm) router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="improvement-authority-panel" data-factory={factoryId} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-600">
          Authority
          <select
            data-testid="improvement-authority-select"
            value={authority}
            onChange={(event) => {
              setAuthority(event.target.value as ImprovementResolvedWire['authority']);
              setPreview(null);
            }}
            className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
          >
            {AUTHORITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {authority === 'canary' ? (
          <>
            <label className="text-xs text-slate-600">
              Canary %
              <input
                data-testid="improvement-canary-percent"
                type="number"
                min={1}
                max={100}
                value={canaryPercent}
                onChange={(event) => setCanaryPercent(event.target.value)}
                className="mt-1 block w-24 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
              />
            </label>
            <label className="text-xs text-slate-600">
              Rollback threshold
              <input
                data-testid="improvement-rollback-threshold"
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={rollbackThreshold}
                onChange={(event) => setRollbackThreshold(event.target.value)}
                className="mt-1 block w-24 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
              />
            </label>
          </>
        ) : null}

        <label className="text-xs text-slate-600">
          Actor
          <input
            data-testid="improvement-authority-actor"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            className="mt-1 block w-40 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
          />
        </label>
        <label className="flex-1 text-xs text-slate-600">
          Reason
          <input
            data-testid="improvement-authority-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="why this authority is right for this factory"
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
          />
        </label>
      </div>

      <p className="text-xs text-slate-500">
        {AUTHORITY_OPTIONS.find((option) => option.value === authority)?.description}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={authorityTone(resolved.authority)} testId="improvement-authority-current">
          current: {resolved.authority} ({resolved.source})
        </Badge>
        <button
          data-testid="improvement-authority-preview"
          type="button"
          disabled={busy !== null}
          onClick={() => void submit(false)}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 disabled:opacity-50"
        >
          {busy === 'preview' ? 'Computing diff…' : 'Preview change'}
        </button>
        <button
          data-testid="improvement-authority-confirm"
          type="button"
          disabled={busy !== null || !preview?.confirmationRequired}
          onClick={() => void submit(true)}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {busy === 'confirm' ? 'Opening PR…' : 'Confirm & open PR'}
        </button>
      </div>

      {error ? (
        <p data-testid="improvement-authority-error" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}

      {preview ? (
        <div data-testid="improvement-authority-diff" className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-xs font-semibold text-slate-800">
            {preview.confirmationRequired
              ? 'Definition change preview — confirm to open a PR'
              : 'Definition change PR opened'}
          </p>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-slate-700">{preview.text}</pre>
          {!preview.confirmationRequired ? (
            <p data-testid="improvement-authority-pr" className="mt-2 text-xs text-slate-700">
              {preview.prUrl ? (
                <a href={preview.prUrl} className="underline decoration-slate-300 underline-offset-2">
                  {preview.prUrl}
                </a>
              ) : (
                'PR recorded without a URL'
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
