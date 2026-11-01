'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FactoryEvent } from '@factory/adapters';
import { Spinner } from '@/components/ui/Spinner';
import { Badge, type Tone } from '@/components/ui/Badge';
import { reduceEvents, type Decisions, type StreamBlock } from '@/lib/events';
import { formatCost, formatTokens } from '@/lib/format';

function blockTone(tone: 'info' | 'ok' | 'error' | 'warning'): Tone {
  switch (tone) {
    case 'ok':
      return 'success';
    case 'error':
      return 'danger';
    case 'warning':
      return 'warning';
    default:
      return 'info';
  }
}

/**
 * The one renderer used by BOTH New Chat and Run detail. That is the product's core
 * claim made visible: chat is a run, and a factory run is chat (ADR-002).
 */
export function EventStream({
  runId,
  events,
  decisions = {},
  focus,
  onDecided,
}: {
  runId: string;
  events: FactoryEvent[];
  decisions?: Decisions;
  /** e.g. `permission:per_1` — highlights and scrolls to the matching block. */
  focus?: string;
  onDecided?: (requestId: string, decision: 'allow' | 'deny') => void;
}) {
  const [localDecisions, setLocalDecisions] = useState<Decisions>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const merged = useMemo<Decisions>(
    () => ({ ...decisions, ...localDecisions }),
    [decisions, localDecisions],
  );

  const blocks = useMemo(() => reduceEvents(events, merged), [events, merged]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const focusedRef = useRef<string | null>(null);

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
  }, []);

  // Auto-scroll only while the reader is pinned to the bottom — never yank the viewport.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [blocks]);

  // Deep links (inbox → run) focus the relevant permission prompt once.
  useEffect(() => {
    if (!focus || focusedRef.current === focus) return;
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-focus-id="${focus}"]`);
    if (!target) return;
    focusedRef.current = focus;
    target.scrollIntoView({ block: 'center' });
  }, [focus, blocks]);

  const decide = async (requestId: string, decision: 'allow' | 'deny'): Promise<void> => {
    setPending((previous) => ({ ...previous, [requestId]: true }));
    setErrors((previous) => {
      const next = { ...previous };
      delete next[requestId];
      return next;
    });

    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/permissions/${encodeURIComponent(requestId)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ decision }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
        throw new Error(body.message ?? body.code ?? `permission request failed (${response.status})`);
      }
      setLocalDecisions((previous) => ({ ...previous, [requestId]: decision }));
      onDecided?.(requestId, decision);
    } catch (error) {
      setErrors((previous) => ({
        ...previous,
        [requestId]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setPending((previous) => {
        const next = { ...previous };
        delete next[requestId];
        return next;
      });
    }
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="event-stream"
      data-block-count={blocks.length}
      className="scroll-stable max-h-[65vh] min-h-[240px] space-y-3 overflow-y-auto px-5 py-4"
    >
      {blocks.length === 0 ? (
        <div data-testid="event-stream-empty" className="flex items-center gap-3 text-sm text-slate-500">
          <Spinner label="Waiting for events" testId="event-stream-spinner" />
        </div>
      ) : null}

      {blocks.map((block) => (
        <StreamBlockView
          key={`${block.kind}-${block.id}`}
          block={block}
          runId={runId}
          focus={focus}
          pending={pending}
          errors={errors}
          onDecide={decide}
        />
      ))}
    </div>
  );
}

function StreamBlockView({
  block,
  runId,
  focus,
  pending,
  errors,
  onDecide,
}: {
  block: StreamBlock;
  runId: string;
  focus?: string;
  pending: Record<string, boolean>;
  errors: Record<string, string>;
  onDecide: (requestId: string, decision: 'allow' | 'deny') => void;
}) {
  switch (block.kind) {
    case 'notice': {
      const terminal = block.text.startsWith('Run completed');
      return (
        <div
          data-testid={terminal ? 'run-terminal' : 'run-started'}
          data-status={terminal ? block.text.split('·').pop()?.trim() : undefined}
          data-seq={block.seq}
          className="flex items-center gap-2 text-xs text-slate-500"
        >
          <Badge tone={blockTone(block.tone)}>{block.text}</Badge>
        </div>
      );
    }

    case 'message': {
      const thinking = block.role === 'reasoning';
      return (
        <div
          data-testid={thinking ? 'event-reasoning' : 'event-message'}
          data-seq={block.seq}
          data-done={block.done ? 'true' : 'false'}
          className={
            thinking
              ? 'rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-600'
              : 'rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm leading-relaxed text-slate-800'
          }
        >
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
            {thinking ? 'thinking' : 'assistant'}
          </p>
          <p className={`whitespace-pre-wrap ${thinking ? 'italic' : ''}`}>{block.text}</p>
        </div>
      );
    }

    case 'tool': {
      const args = block.argsDelta.length > 0 ? block.argsDelta : block.argsStart;
      const tone: Tone = block.ok === null ? 'info' : block.ok ? 'success' : 'danger';
      return (
        <div
          data-testid="tool-call"
          data-tool-name={block.name}
          data-call-id={block.callId}
          data-ok={block.ok === null ? 'pending' : block.ok ? 'true' : 'false'}
          data-seq={block.seq}
          className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tone} testId="tool-call-status">
              {block.ok === null ? 'running' : block.ok ? 'ok' : 'failed'}
            </Badge>
            <span className="font-mono text-xs text-slate-800">{block.name}</span>
            <span className="font-mono text-[11px] text-slate-400">{block.callId}</span>
          </div>
          {args ? (
            <pre
              data-testid="tool-call-args"
              className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-white p-2 font-mono text-[11px] text-slate-600"
            >
              {args}
            </pre>
          ) : null}
          {block.result ? (
            <pre
              data-testid="tool-call-result"
              className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-white p-2 font-mono text-[11px] text-slate-500"
            >
              {block.result}
            </pre>
          ) : null}
        </div>
      );
    }

    case 'permission': {
      const isFocused = focus === `permission:${block.requestId}`;
      const isPending = block.status === 'pending';
      const tone: Tone =
        block.status === 'allowed' ? 'success' : block.status === 'denied' ? 'danger' : 'warning';
      return (
        <div
          data-testid="permission-prompt"
          data-request-id={block.requestId}
          data-status={block.status}
          data-focus-id={`permission:${block.requestId}`}
          data-focused={isFocused ? 'true' : 'false'}
          data-seq={block.seq}
          className={`rounded-lg border bg-white px-4 py-3 text-sm ${
            isFocused ? 'border-slate-900 ring-2 ring-slate-300' : 'border-amber-300'
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tone} testId="permission-status">
              {block.status}
            </Badge>
            <span className="text-xs font-medium text-slate-700">
              Permission requested for <span className="font-mono">{block.action}</span>
            </span>
          </div>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-600">
            {JSON.stringify(block.detail, null, 2)}
          </pre>

          {isPending ? (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                data-testid="permission-allow"
                disabled={Boolean(pending[block.requestId])}
                onClick={() => void onDecide(block.requestId, 'allow')}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-300 disabled:opacity-50"
              >
                Allow
              </button>
              <button
                type="button"
                data-testid="permission-deny"
                disabled={Boolean(pending[block.requestId])}
                onClick={() => void onDecide(block.requestId, 'deny')}
                className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:opacity-50"
              >
                Deny
              </button>
            </div>
          ) : (
            <p data-testid="permission-outcome" className="mt-2 text-xs text-slate-500">
              Decision recorded: {block.status}
            </p>
          )}

          {errors[block.requestId] ? (
            <p data-testid="permission-error" role="alert" className="mt-2 text-xs text-red-600">
              {errors[block.requestId]}
            </p>
          ) : null}
        </div>
      );
    }

    case 'file':
      return (
        <div
          data-testid="file-edited"
          data-path={block.path}
          data-seq={block.seq}
          className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm"
        >
          <div className="flex items-center gap-2">
            <Badge tone="info">file edited</Badge>
            <span className="font-mono text-xs text-slate-700">{block.path}</span>
          </div>
          <pre
            data-testid="file-diff"
            className="mt-2 overflow-x-auto whitespace-pre rounded bg-slate-900 p-3 font-mono text-[11px] leading-5 text-slate-100"
          >
            {block.diff}
          </pre>
        </div>
      );

    case 'artifact':
      return (
        <div
          data-testid="artifact-event"
          data-path={block.path}
          data-seq={block.seq}
          className="flex items-center gap-2 text-xs text-slate-600"
        >
          <Badge tone="neutral">artifact</Badge>
          <span className="font-mono">{block.path}</span>
          {block.bytes !== null ? <span className="text-slate-400">{block.bytes} bytes</span> : null}
        </div>
      );

    case 'usage':
      return (
        <div data-testid="usage-chip" data-seq={block.seq} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <Badge tone="neutral" testId="usage-cost">
            {formatCost(block.costUsd)}
          </Badge>
          <span>
            in {formatTokens(block.inputTokens)} · out {formatTokens(block.outputTokens)}
            {block.cacheReadTokens > 0 ? ` · cache ${formatTokens(block.cacheReadTokens)}` : ''}
            {block.reasoningTokens > 0 ? ` · reasoning ${formatTokens(block.reasoningTokens)}` : ''}
          </span>
        </div>
      );

    default:
      return null;
  }
}
