'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { GithubIntegrationWire } from '@/lib/types';

/**
 * GitHub connection form (spec `code-forge` › credential by reference). The console never
 * receives a token: it sends a secret *name* and the API resolves the value at run time.
 * Dry-run and "queue owns merges" are explicit toggles (ADR-022/ADR-023).
 */
export function GithubIntegrationForm({
  factoryId,
  integration,
}: {
  factoryId: string;
  integration: GithubIntegrationWire;
}) {
  const router = useRouter();
  const [secretRef, setSecretRef] = useState(integration.secretRef ?? 'GITHUB_TOKEN');
  const [webhookSecretRef, setWebhookSecretRef] = useState(
    integration.webhookSecretRef ?? 'GITHUB_WEBHOOK_SECRET',
  );
  const [repos, setRepos] = useState(
    integration.repos.map((repo) => `${repo.owner}/${repo.name}`).join(', '),
  );
  const [events, setEvents] = useState(integration.events.join(', '));
  const [labels, setLabels] = useState(integration.labels.join(', '));
  const [branch, setBranch] = useState(integration.branch ?? '');
  const [dryRun, setDryRun] = useState(integration.dryRun);
  const [mergeQueue, setMergeQueue] = useState(integration.mergeQueue);
  const [skipBots, setSkipBots] = useState<'all' | 'none'>(integration.skipBots);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    const repoList = repos
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [owner, name] = entry.split('/');
        return { owner: owner?.trim() ?? '', name: name?.trim() ?? '' };
      });
    if (repoList.some((repo) => !repo.owner || !repo.name)) {
      setError('repositories must be written as owner/name');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/factories/${encodeURIComponent(factoryId)}/integrations/github`,
        {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          secretRef: secretRef.trim(),
          webhookSecretRef: webhookSecretRef.trim(),
          repos: repoList,
          events: events.split(',').map((entry) => entry.trim()).filter(Boolean),
          labels: labels.split(',').map((entry) => entry.trim()).filter(Boolean),
          ...(branch.trim() ? { branch: branch.trim() } : {}),
          dryRun,
          mergeQueue,
          skipBots,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
      };
      if (!response.ok) {
        throw new Error(payload.message ?? payload.code ?? `request failed (${response.status})`);
      }
      setNotice('GitHub connection saved.');
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  const field = 'mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900';

  return (
    <div className="space-y-3" data-testid="github-integration-form">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-600">
          Token secret reference
          <input
            data-testid="github-secret-ref-input"
            value={secretRef}
            onChange={(event) => setSecretRef(event.target.value)}
            className={field}
          />
          <span className="mt-1 block text-[11px] text-slate-500">
            A secret name, never a value. The client resolves it at run time.
          </span>
        </label>
        <label className="text-xs text-slate-600">
          Webhook secret reference
          <input
            data-testid="github-webhook-secret-ref-input"
            value={webhookSecretRef}
            onChange={(event) => setWebhookSecretRef(event.target.value)}
            className={field}
          />
        </label>
      </div>

      <label className="block text-xs text-slate-600">
        Repositories (owner/name, comma separated)
        <input
          data-testid="github-repos-input"
          value={repos}
          onChange={(event) => setRepos(event.target.value)}
          placeholder="acme/api-service"
          className={field}
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-600">
          Events
          <input
            data-testid="github-events-input"
            value={events}
            onChange={(event) => setEvents(event.target.value)}
            className={field}
          />
        </label>
        <label className="text-xs text-slate-600">
          Labels
          <input
            data-testid="github-labels-input"
            value={labels}
            onChange={(event) => setLabels(event.target.value)}
            className={field}
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-600">
          Branch filter (optional)
          <input
            data-testid="github-branch-input"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="main"
            className={field}
          />
        </label>
        <label className="text-xs text-slate-600">
          Bot senders
          <select
            data-testid="github-skip-bots-input"
            value={skipBots}
            onChange={(event) => setSkipBots(event.target.value as 'all' | 'none')}
            className={field}
          >
            <option value="all">skip all (default)</option>
            <option value="none">keep bots</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-4 text-xs text-slate-700">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="github-dry-run-input"
            checked={dryRun}
            onChange={(event) => setDryRun(event.target.checked)}
          />
          Dry run (no repository mutation)
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="github-merge-queue-input"
            checked={mergeQueue}
            onChange={(event) => setMergeQueue(event.target.checked)}
          />
          Merge queue owns merges
        </label>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="github-save"
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save connection'}
        </button>
        {error ? (
          <span data-testid="github-form-error" className="text-xs text-red-700">
            {error}
          </span>
        ) : null}
        {notice ? (
          <span data-testid="github-form-notice" className="text-xs text-emerald-700">
            {notice}
          </span>
        ) : null}
      </div>
    </div>
  );
}
