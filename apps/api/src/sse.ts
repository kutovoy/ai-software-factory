/**
 * Server-Sent Events projection of a run's append-only event log.
 *
 * Contract (spec `event-stream`):
 *   - `id:` is the event `seq`
 *   - `event:` is the canonical FactoryEvent type
 *   - `data:` is the full event JSON
 *   - replay from `Last-Event-ID` returns strictly `seq > lastEventId`, no gaps/dupes
 *   - the stream emits the terminal event and closes
 *
 * The stream only reads Postgres — it never touches the runner or Temporal, and there is
 * exactly one writer per run (the workflow's pump activity), so ordering is guaranteed.
 */

export interface SseEvent {
  seq: number;
  type: string;
  payload: unknown;
}

export function formatSseFrame(event: SseEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

export function formatHeartbeat(): string {
  return ': keep-alive\n\n';
}

export function parseLastEventId(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export interface EventStreamOptions {
  /** Highest seq the client already has. */
  lastEventId: number;
  /** Returns events with `seq > afterSeq`, ordered ascending. */
  fetchPage: (afterSeq: number) => Promise<SseEvent[]>;
  /** True when the run row is in a terminal state. */
  isTerminal: () => Promise<boolean>;
  pollMs?: number;
  heartbeatMs?: number;
  maxLifetimeMs?: number;
  /** Aborted when the client disconnects. */
  signal?: AbortSignal;
}

export function createEventStream(options: EventStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pollMs = options.pollMs ?? 200;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxLifetimeMs = options.maxLifetimeMs ?? 30 * 60 * 1000;

  let cursor = options.lastEventId;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = (): void => {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const abort = (): void => finish();
      options.signal?.addEventListener('abort', abort, { once: true });

      void (async () => {
        const started = Date.now();
        let lastWrite = Date.now();

        try {
          for (;;) {
            if (stopped || options.signal?.aborted) return finish();
            if (Date.now() - started > maxLifetimeMs) return finish();

            const page = await options.fetchPage(cursor);
            for (const event of page) {
              if (stopped) return;
              controller.enqueue(encoder.encode(formatSseFrame(event)));
              cursor = event.seq;
              lastWrite = Date.now();
              if (event.type === 'run.completed') return finish();
            }

            if (page.length === 0 && (await options.isTerminal())) {
              // Terminal run with nothing left to replay: close without a dangling stream.
              return finish();
            }

            if (Date.now() - lastWrite >= heartbeatMs) {
              controller.enqueue(encoder.encode(formatHeartbeat()));
              lastWrite = Date.now();
            }

            await sleep(pollMs);
          }
        } catch (error) {
          try {
            controller.error(error);
          } catch {
            // stream already closed
          }
        }
      })();
    },
    cancel() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  });
}
