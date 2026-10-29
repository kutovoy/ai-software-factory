'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EventStream } from '@/components/stream/EventStream';
import { useRunStream } from '@/components/stream/useRunStream';
import { terminalEvent } from '@/lib/events';
import { formatCost } from '@/lib/format';
import type { RunSummary } from '@/lib/types';

const HARNESSES = ['opencode', 'claude-code', 'codex', 'gemini', 'generic-cli', 'fake'] as const;

function statusTone(status: string): Tone {
  if (status === 'ok') return 'success';
  if (status === 'error') return 'danger';
  if (status === 'cancelled') return 'warning';
  if (status === 'running') return 'info';
  return 'neutral';
}

export function NewChat({
  factory,
  defaultHarness,
  defaultModel,
}: {
  factory: string;
  defaultHarness: string;
  defaultModel: string;
}) {
  const [prompt, setPrompt] = useState('');
  const [harness, setHarness] = useState(defaultHarness);
  const [model, setModel] = useState(defaultModel);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<RunSummary | null>(null);

  const { events, status: streamStatus, gapDetected } = useRunStream(run?.id ?? null);

  const terminal = useMemo(() => terminalEvent(events), [events]);
  const lastUsage = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event && event.type === 'usage.updated') return event;
    }
    return null;
  }, [events]);

  const runStatus = terminal?.status ?? (run ? 'running' : 'idle');
  const cost = lastUsage?.costUsd ?? run?.costUsd ?? null;

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (prompt.trim().length === 0 || submitting) return;

    setSubmitting(true);
    setError(null);

    const body: Record<string, unknown> = {
      factory,
      prompt: prompt.trim(),
      harness,
    };
    if (harness !== 'fake' && model.trim().length > 0) body.model = model.trim();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        run?: RunSummary;
        message?: string;
        code?: string;
      };
      if (!response.ok || !payload.run) {
        throw new Error(payload.message ?? payload.code ?? `run creation failed (${response.status})`);
      }
      setRun(payload.run);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card testId="chat-composer">
        <CardHeader
          title="New Chat"
          hint="A chat is a run: the same FactoryEvent stream a factory run produces."
        />
        <CardBody>
          <form onSubmit={submit} className="space-y-3">
            <label htmlFor="chat-prompt" className="block text-xs font-medium text-slate-600">
              Prompt
            </label>
            <textarea
              id="chat-prompt"
              data-testid="chat-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              placeholder="Ask the factory foreman to do something…"
              className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />

            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="chat-harness" className="block text-xs font-medium text-slate-600">
                  Harness
                </label>
                <select
                  id="chat-harness"
                  data-testid="chat-harness"
                  value={harness}
                  onChange={(event) => setHarness(event.target.value)}
                  className="mt-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
                >
                  {HARNESSES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="chat-model" className="block text-xs font-medium text-slate-600">
                  Model
                </label>
                <input
                  id="chat-model"
                  data-testid="chat-model"
                  value={harness === 'fake' ? 'fake/fake-model' : model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={harness === 'fake'}
                  placeholder="factory default"
                  className="mt-1 w-64 rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 disabled:bg-slate-100 disabled:text-slate-500"
                />
              </div>

              <button
                type="submit"
                data-testid="chat-submit"
                disabled={submitting || prompt.trim().length === 0}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:opacity-50"
              >
                {submitting ? 'Starting…' : 'Send'}
              </button>
            </div>

            <p className="text-xs text-slate-500">
              Factory defaults: <span className="font-mono">{factory}</span> ·{' '}
              <span className="font-mono">{defaultHarness}</span>
              {defaultModel ? (
                <>
                  {' '}
                  · <span className="font-mono">{defaultModel}</span>
                </>
              ) : null}
            </p>

            {error ? (
              <p data-testid="chat-error" role="alert" className="text-sm text-red-600">
                {error}
              </p>
            ) : null}
          </form>
        </CardBody>
      </Card>

      {run ? (
        <Card testId="run-header" className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Run</span>
            <Link
              href={`/runs/${run.id}`}
              data-testid="run-link"
              data-run-id={run.id}
              className="font-mono text-xs text-slate-700 underline decoration-slate-300 underline-offset-2"
            >
              {run.id}
            </Link>
            <Badge tone={statusTone(runStatus)} testId="run-status">
              {runStatus}
            </Badge>
            <Badge tone="neutral" testId="run-harness" mono>
              {run.harness}
            </Badge>
            <Badge tone="neutral" testId="run-model" mono>
              {run.model ?? '—'}
            </Badge>
            <Badge tone="neutral" testId="run-cost">
              {formatCost(cost)}
            </Badge>
            <span className="ml-auto text-xs text-slate-400" data-testid="run-stream-status">
              {streamStatus}
              {gapDetected ? ' · gap backfilled' : ''}
            </span>
          </div>
          <EventStream runId={run.id} events={events} />
        </Card>
      ) : null}
    </div>
  );
}
