'use client';

import dynamic from 'next/dynamic';
import {
  Component,
  useCallback,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';

/**
 * Live API explorer for `/help/api` (`web-console` spec: "Executable API explorer").
 *
 * Swagger UI is browser-only, so it is imported dynamically with `ssr: false`; its stylesheet
 * is imported once in the root layout (App Router only allows global CSS there). The document
 * is the one the console already proxies (`/api/openapi.json`), so the explorer cannot drift
 * from what the API serves.
 *
 * The explorer loads `?servers=console`, so the Servers selector names the origin requests
 * actually use. "Try it out" must not hit CORS: that variant declares the console origin (`/`)
 * as its server, and every request reaches the backend through the catch-all proxy at
 * `src/app/api/v1/[...path]/route.ts` — the documented way to run Swagger UI without CORS
 * (<https://swagger.io/docs/open-source-tools/swagger-ui/usage/cors/>). The request
 * interceptor stays as a safety net for a stale cached document that still names the API host.
 *
 * Presentation follows the classic Swagger UI layout: full width, filter box, alphabetical
 * tags/operations, request durations, extensions and tag descriptions
 * (<https://swagger.io/docs/open-source-tools/swagger-ui/usage/configuration/>).
 */

const SPEC_URL = '/api/openapi.json?servers=console';
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

const SwaggerUI = dynamic(() => import('swagger-ui-react'), {
  ssr: false,
  loading: () => (
    <ExplorerNotice
      testId="api-explorer-loading"
      tone="loading"
      title="Loading the live explorer"
      text="Fetching the Swagger UI bundle and the served OpenAPI document."
    />
  ),
});

interface InterceptedRequest {
  url?: string;
  [key: string]: unknown;
}

/** Swagger UI sends to the spec's server URL; keep every call on the console origin. */
function sameOriginRequest(request: InterceptedRequest): InterceptedRequest {
  const raw = String(request.url ?? '');
  const url = new URL(raw, window.location.origin);
  if (url.origin === window.location.origin) return request;

  // The document also lists the unversioned probe; route it through the versioned proxy.
  if (url.pathname === '/health') {
    return { ...request, url: `${window.location.origin}/api/v1/health` };
  }
  if (url.pathname.startsWith('/api/v1/')) {
    return { ...request, url: `${window.location.origin}${url.pathname}${url.search}` };
  }
  return request;
}

interface OpenApiDocument {
  info?: { version?: string };
  paths?: Record<string, Record<string, unknown>>;
}

function countOperations(document: OpenApiDocument): number {
  let operations = 0;
  for (const item of Object.values(document.paths ?? {})) {
    for (const method of Object.keys(item ?? {})) {
      if (HTTP_METHODS.has(method.toLowerCase())) operations += 1;
    }
  }
  return operations;
}

type Probe =
  | { state: 'loading' }
  | { state: 'ready'; operations: number; version: string }
  | { state: 'error'; message: string };

const TONES = {
  loading: 'border-slate-200 bg-white text-slate-700',
  error: 'border-amber-200 bg-amber-50 text-amber-900',
} as const;

function ExplorerNotice({
  testId,
  tone,
  title,
  text,
  onRetry,
}: {
  testId: string;
  tone: keyof typeof TONES;
  title: string;
  text: string;
  onRetry?: () => void;
}) {
  return (
    <div data-testid={testId} role="status" className={`rounded-xl border px-4 py-3 text-sm ${TONES[tone]}`}>
      <p className="font-semibold">{title}</p>
      <p className="mt-1 max-w-prose text-xs leading-5">{text}</p>
      {onRetry ? (
        <button
          type="button"
          data-testid="api-explorer-retry"
          onClick={onRetry}
          className="mt-2 rounded border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** A chunk or render failure must not leave the page with an empty shell. */
class ExplorerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <ExplorerNotice
          testId="api-explorer-error"
          tone="error"
          title="The explorer could not start"
          text="The Swagger UI bundle failed to render. The endpoint reference below is still complete and readable; reload the page to try again."
        />
      );
    }
    return this.props.children;
  }
}

/**
 * Swagger UI reads `tagsSorter`/`operationsSorter`, but `@types/swagger-ui-react@5.18` does not
 * declare them; extending the derived prop type keeps every other flag checked.
 */
interface ExplorerUiProps extends ComponentProps<typeof SwaggerUI> {
  tagsSorter: 'alpha';
  operationsSorter: 'alpha';
}

/** What LiteLLM's page has and ours did not: search, sorting, metadata and tag context. */
const EXPLORER_UI: ExplorerUiProps = {
  url: SPEC_URL,
  filter: true,
  tagsSorter: 'alpha',
  operationsSorter: 'alpha',
  displayRequestDuration: true,
  showExtensions: true,
  showCommonExtensions: true,
  docExpansion: 'list',
  defaultModelsExpandDepth: -1,
  deepLinking: true,
  tryItOutEnabled: true,
  persistAuthorization: true,
  showMutatedRequest: true,
  requestInterceptor: sameOriginRequest,
};

/**
 * The part of Swagger UI's Standalone topbar that matters here: what is versioned, where
 * requests actually go, and that console auth is carried by the session cookie.
 */
function ExplorerToolbar({ version }: { version?: string }) {
  return (
    <div
      data-testid="api-explorer-toolbar"
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs text-slate-600"
    >
      <span data-testid="api-explorer-version">
        API version <span className="font-mono text-slate-900">{version ? `v${version}` : '—'}</span>
      </span>
      <span data-testid="api-explorer-base-url">
        Base URL <span className="font-mono text-slate-900">/api/v1</span> on the console origin, proxied
        server-side to the API
      </span>
      <span
        data-testid="api-explorer-no-auth"
        className="rounded border border-sky-200 bg-sky-50 px-2 py-0.5 font-medium text-sky-900"
      >
        Session cookie forwarded — sign in when AUTH_REQUIRED=1
      </span>
    </div>
  );
}

export function ApiExplorer() {
  const [probe, setProbe] = useState<Probe>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setProbe({ state: 'loading' });

    fetch(SPEC_URL, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GET ${SPEC_URL} returned ${response.status}`);
        return (await response.json()) as OpenApiDocument;
      })
      .then((document) => {
        const operations = countOperations(document);
        if (operations === 0) throw new Error('the document lists no operations');
        setProbe({ state: 'ready', operations, version: document.info?.version ?? '' });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setProbe({ state: 'error', message: error instanceof Error ? error.message : String(error) });
      });

    return () => controller.abort();
  }, [attempt]);

  const version = probe.state === 'ready' ? probe.version : undefined;

  if (probe.state === 'loading') {
    return (
      <div className="space-y-3">
        <ExplorerToolbar version={version} />
        <ExplorerNotice
          testId="api-explorer-loading"
          tone="loading"
          title="Loading the live explorer"
          text="Fetching the served OpenAPI document; the explorer appears when the document is available."
        />
      </div>
    );
  }

  if (probe.state === 'error') {
    return (
      <div className="space-y-3">
        <ExplorerToolbar version={version} />
        <ExplorerNotice
          testId="api-explorer-error"
          tone="error"
          title="The live explorer is unavailable right now"
          text={`The explorer could not read GET ${SPEC_URL} (${probe.message}). Nothing is invented here — start the stack or check GET /health, then retry. The static reference below still lists what the API serves.`}
          onRetry={retry}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ExplorerToolbar version={version} />
      <div data-testid="api-explorer" data-operations={probe.operations} className="api-explorer-shell">
        <ExplorerBoundary>
          <SwaggerUI {...EXPLORER_UI} />
        </ExplorerBoundary>
      </div>
    </div>
  );
}
