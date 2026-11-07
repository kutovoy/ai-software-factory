'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Console-wide backend liveness. The browser pings the same-origin `/api/v1/health`
 * proxy, which also covers a restart of the Next server: a failed RSC refresh must not
 * turn the whole app into a white page. While offline the shell stays mounted, a banner
 * explains the connection issue and retry is automatic (5s) plus manual.
 */

type ServerStatus = 'checking' | 'online' | 'offline';

interface ServerConnectionValue {
  status: ServerStatus;
  /** True unless the last probe failed; `checking` keeps auto-refresh enabled. */
  online: boolean;
  retry: () => void;
}

const ServerConnectionContext = createContext<ServerConnectionValue>({
  status: 'online',
  online: true,
  retry: () => {},
});

export function useServerConnection(): ServerConnectionValue {
  return useContext(ServerConnectionContext);
}

const PROBE_TIMEOUT_MS = 5_000;
const ONLINE_POLL_MS = 15_000;
const OFFLINE_POLL_MS = 5_000;

interface ProbeResult {
  ok: boolean;
  detail: string | null;
}

async function probe(): Promise<ProbeResult> {
  try {
    const response = await fetch('/api/v1/health', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true, detail: null };

    const body = (await response.json().catch(() => null)) as
      | { status?: string; checks?: unknown }
      | null;
    const state = body?.status ? ` (${body.status})` : '';
    return { ok: false, detail: `API health check returned ${response.status}${state}.` };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function ServerConnectionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<ServerStatus>('checking');
  const [detail, setDetail] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const wasOffline = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const run = async (): Promise<void> => {
      const result = await probe();
      if (cancelled) return;
      setStatus(result.ok ? 'online' : 'offline');
      setDetail(result.detail);
      timer = window.setTimeout(run, result.ok ? ONLINE_POLL_MS : OFFLINE_POLL_MS);
    };

    void run();
    const onOnline = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      void run();
    };
    window.addEventListener('online', onOnline);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [attempt]);

  // Once the backend is back, re-run the current server components so the shell and the
  // page projection catch up without a full browser reload.
  useEffect(() => {
    if (status === 'offline') {
      wasOffline.current = true;
      return;
    }
    if (status === 'online' && wasOffline.current) {
      wasOffline.current = false;
      router.refresh();
    }
  }, [router, status]);

  const retry = (): void => {
    setStatus('checking');
    setAttempt((value) => value + 1);
  };

  return (
    <ServerConnectionContext.Provider
      value={{ status, online: status !== 'offline', retry }}
    >
      {status === 'offline' ? (
        <div
          data-testid="server-connection"
          role="alert"
          aria-live="polite"
          className="sticky top-0 z-50 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 shadow-sm"
        >
          <div className="mx-auto flex max-w-[110rem] flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold">Server connection issue</span>
            <span className="text-amber-800">
              {detail ?? 'The backend is unavailable.'} The page is preserved; actions may fail
              until the connection returns.
            </span>
            <button
              type="button"
              onClick={retry}
              className="ml-auto rounded-md border border-amber-400 bg-white px-2.5 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-400/50"
            >
              Retry now
            </button>
            <span className="text-xs text-amber-700">Retrying automatically every 5s.</span>
          </div>
        </div>
      ) : null}
      {children}
    </ServerConnectionContext.Provider>
  );
}
