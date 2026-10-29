'use client';

import { useEffect, useRef, useState } from 'react';
import type { FactoryEvent } from '@factory/adapters';
import { EVENT_TYPES } from '@/lib/events';

export type StreamStatus = 'idle' | 'connecting' | 'streaming' | 'reconnecting' | 'closed' | 'error';

export interface RunStreamState {
  events: FactoryEvent[];
  status: StreamStatus;
  /** True when a seq gap was observed and a backfill reconnect was triggered. */
  gapDetected: boolean;
  lastSeq: number;
}

const MAX_RETRIES = 6;

/**
 * Subscribes to `GET /api/runs/:id/events` (a same-origin proxy of the API SSE stream).
 *
 * Contract (spec `web-console`):
 *   - replay by `seq`: reconnect sends `lastEventId=<last seen seq>`, so no duplicates/gaps
 *   - gap detection: a jump in `seq` forces a backfill reconnect from the last seen seq
 *   - terminal close: `run.completed` closes the EventSource and stops reconnecting
 */
export function useRunStream(runId: string | null): RunStreamState {
  const [events, setEvents] = useState<FactoryEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [gapDetected, setGapDetected] = useState(false);
  const [lastSeq, setLastSeq] = useState(0);

  const seenRef = useRef<Set<number>>(new Set());
  const lastSeqRef = useRef(0);

  useEffect(() => {
    if (!runId) return;

    let disposed = false;
    let terminal = false;
    let retries = 0;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const closeSource = (): void => {
      source?.close();
      source = null;
    };

    const connect = (): void => {
      if (disposed || terminal) return;
      setStatus(lastSeqRef.current === 0 ? 'connecting' : 'streaming');

      const url = `/api/runs/${encodeURIComponent(runId)}/events?lastEventId=${lastSeqRef.current}`;
      const es = new EventSource(url);
      source = es;

      const onEvent = (message: MessageEvent<string>): void => {
        if (disposed || terminal) return;
        let event: FactoryEvent;
        try {
          event = JSON.parse(message.data) as FactoryEvent;
        } catch {
          return;
        }

        const seq = typeof event.seq === 'number' ? event.seq : lastSeqRef.current + 1;

        if (seenRef.current.has(seq)) return;

        // Gap: we skipped a sequence number. Reconnect from the last contiguous seq and
        // let the server replay the missing page (SSE replay is strictly `seq > cursor`).
        if (lastSeqRef.current > 0 && seq > lastSeqRef.current + 1) {
          setGapDetected(true);
          closeSource();
          retryTimer = setTimeout(connect, 50);
          return;
        }

        seenRef.current.add(seq);
        lastSeqRef.current = Math.max(lastSeqRef.current, seq);
        setLastSeq(lastSeqRef.current);
        retries = 0;
        setStatus('streaming');
        setEvents((previous) => [...previous, event]);

        if (event.type === 'run.completed') {
          terminal = true;
          setStatus('closed');
          closeSource();
        }
      };

      for (const type of EVENT_TYPES) {
        es.addEventListener(type, onEvent as EventListener);
      }

      es.onerror = () => {
        if (disposed || terminal) return;
        closeSource();
        retries += 1;
        if (retries > MAX_RETRIES) {
          setStatus('error');
          return;
        }
        setStatus('reconnecting');
        retryTimer = setTimeout(connect, Math.min(500 * retries, 4000));
      };
    };

    connect();

    return () => {
      disposed = true;
      closeSource();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [runId]);

  return { events, status, gapDetected, lastSeq };
}
