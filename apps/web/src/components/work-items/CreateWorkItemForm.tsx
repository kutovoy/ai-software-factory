'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const TYPES = ['task', 'bug', 'incident', 'pr_review'] as const;
const HARNESSES = [
  { value: '', label: 'Factory default' },
  { value: 'fake', label: 'fake (no credentials)' },
  { value: 'opencode', label: 'opencode' },
  { value: 'claude-code', label: 'claude-code' },
  { value: 'codex', label: 'codex' },
  { value: 'gemini', label: 'gemini' },
  { value: 'generic-cli', label: 'generic-cli' },
] as const;

/**
 * Manual work-item creation (`POST /work-items`). The API compiles the factory's stage
 * graph and starts `FactoryWorkflow` before responding, so a failure here is a real
 * refusal (invalid graph, unauthorized spawn, orchestrator unavailable) — surfaced verbatim.
 */
export function CreateWorkItemForm({
  factories,
  defaultFactory,
}: {
  factories: string[];
  defaultFactory: string;
}) {
  const router = useRouter();
  const [factory, setFactory] = useState(
    factories.includes(defaultFactory) ? defaultFactory : (factories[0] ?? defaultFactory),
  );
  const [title, setTitle] = useState('');
  const [type, setType] = useState<string>('task');
  const [prompt, setPrompt] = useState('');
  const [harness, setHarness] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError('a title is required');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/work-items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          factory,
          title: title.trim(),
          type,
          source: 'manual',
          ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
          ...(harness ? { harness } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
        workItem?: { id?: string };
      };
      if (!response.ok) {
        throw new Error(body.message ?? body.code ?? `work item creation failed (${response.status})`);
      }
      const id = body.workItem?.id;
      if (!id) throw new Error('the API did not return a work item id');
      router.push(`/work-items/${encodeURIComponent(id)}`);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form data-testid="work-item-create" onSubmit={(event) => void submit(event)} className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-600">
          Factory
          <select
            data-testid="create-factory"
            value={factory}
            onChange={(event) => setFactory(event.target.value)}
            className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            {factories.length === 0 ? <option value={defaultFactory}>{defaultFactory}</option> : null}
            {factories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs text-slate-600">
          Type
          <select
            data-testid="create-type"
            value={type}
            onChange={(event) => setType(event.target.value)}
            className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            {TYPES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="min-w-[16rem] flex-1 text-xs text-slate-600">
          Title
          <input
            data-testid="create-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What should the factory work on?"
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        <label className="text-xs text-slate-600">
          Harness
          <select
            data-testid="create-harness"
            value={harness}
            onChange={(event) => setHarness(event.target.value)}
            className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            {HARNESSES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          data-testid="create-submit"
          disabled={busy}
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? 'Starting…' : 'Create work item'}
        </button>
      </div>

      <label className="block text-xs text-slate-600">
        Prompt (optional — defaults to the title + source context)
        <textarea
          data-testid="create-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={2}
          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
      </label>

      <p className="text-[11px] text-slate-500">
        Source is recorded as <span className="font-mono">manual</span>. The item is persisted first, then
        its durable workflow starts — so the card survives a worker restart.
      </p>

      {error ? (
        <p data-testid="create-error" role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </form>
  );
}
