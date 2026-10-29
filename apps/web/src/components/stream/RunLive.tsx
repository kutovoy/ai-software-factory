'use client';

import { useMemo } from 'react';
import { Badge, type Tone } from '@/components/ui/Badge';
import { EventStream } from '@/components/stream/EventStream';
import { useRunStream } from '@/components/stream/useRunStream';
import { decisionsFromPermissions, terminalEvent } from '@/lib/events';
import type { PermissionRow } from '@/lib/types';

function statusTone(status: string): Tone {
  if (status === 'ok') return 'success';
  if (status === 'error') return 'danger';
  if (status === 'cancelled') return 'warning';
  if (status === 'running') return 'info';
  return 'neutral';
}

/**
 * Run detail's live half: replays the persisted log from seq 0, then tails. The same
 * `EventStream` renderer as New Chat — that is the point of the product.
 */
export function RunLive({
  runId,
  initialStatus,
  permissions,
  focus,
}: {
  runId: string;
  initialStatus: string;
  permissions: PermissionRow[];
  focus?: string;
}) {
  const { events, status: streamStatus, gapDetected, lastSeq } = useRunStream(runId);
  const terminal = useMemo(() => terminalEvent(events), [events]);
  const decisions = useMemo(() => decisionsFromPermissions(permissions), [permissions]);
  const status = terminal?.status ?? initialStatus;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3">
        <Badge tone={statusTone(status)} testId="run-status">
          {status}
        </Badge>
        <span data-testid="run-stream-status" className="text-xs text-slate-500">
          stream: {streamStatus}
          {gapDetected ? ' · gap backfilled' : ''}
        </span>
        <span data-testid="run-last-seq" className="text-xs text-slate-400">
          last seq {lastSeq}
        </span>
      </div>
      <EventStream runId={runId} events={events} decisions={decisions} focus={focus} />
    </div>
  );
}
