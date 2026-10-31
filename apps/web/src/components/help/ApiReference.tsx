import { getOrError } from '@/lib/api';

/**
 * `/help/api` renders the endpoint reference from the served OpenAPI document
 * (`GET /api/v1/openapi.json`, `http-api` spec: "Spec access"). It is fetched through
 * `lib/api.ts`, so the browser-facing link is the same-origin proxy and the backend prefix
 * stays server-side (ADR-030).
 *
 * The document is the source of truth: a route that exists without a spec entry fails the
 * API contract test, so this page cannot silently drift from what is served.
 */

interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: { type?: string };
}

interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: unknown;
  responses?: Record<string, { description?: string }>;
}

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; summary?: string; description?: string };
  servers?: Array<{ url?: string; description?: string }>;
  tags?: Array<{ name?: string; description?: string }>;
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

const METHOD_TONES: Record<string, string> = {
  get: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  post: 'border-sky-200 bg-sky-50 text-sky-800',
  put: 'border-indigo-200 bg-indigo-50 text-indigo-800',
  patch: 'border-amber-200 bg-amber-50 text-amber-800',
  delete: 'border-rose-200 bg-rose-50 text-rose-800',
  head: 'border-slate-200 bg-slate-50 text-slate-700',
  options: 'border-slate-200 bg-slate-50 text-slate-700',
};

interface Endpoint {
  method: string;
  path: string;
  operation: OpenApiOperation;
  resource: string;
}

function resourceFor(path: string, operation: OpenApiOperation): string {
  const tag = operation.tags?.[0];
  if (tag) return tag;
  const segments = path.replace(/^\/api\/v1\/?/, '').split('/').filter(Boolean);
  return segments[0] ?? 'root';
}

function collectEndpoints(document: OpenApiDocument): Endpoint[] {
  const endpoints: Endpoint[] = [];
  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = operations[method];
      if (!operation) continue;
      endpoints.push({
        method: method.toUpperCase(),
        path,
        operation,
        resource: resourceFor(path, operation),
      });
    }
  }
  return endpoints;
}

function MethodBadge({ method }: { method: string }) {
  const tone = METHOD_TONES[method.toLowerCase()] ?? METHOD_TONES.get;
  return (
    <span
      className={`inline-flex w-16 shrink-0 justify-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}
    >
      {method}
    </span>
  );
}

function EndpointCard({ endpoint }: { endpoint: Endpoint }) {
  const { method, path, operation } = endpoint;
  const parameters = operation.parameters ?? [];
  const responses = Object.entries(operation.responses ?? {});

  return (
    <li
      data-testid="api-endpoint"
      data-method={method}
      data-path={path}
      className="min-w-0 rounded-lg border border-slate-200 bg-white px-4 py-3"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <MethodBadge method={method} />
        <code className="min-w-0 break-all font-mono text-xs text-slate-900">{path}</code>
      </div>
      <p data-testid="api-endpoint-summary" className="mt-1.5 text-sm font-medium text-slate-900">
        {operation.summary ?? 'No summary in the spec'}
      </p>
      {operation.description ? (
        <p className="mt-1 max-w-prose text-xs leading-5 text-slate-600">{operation.description}</p>
      ) : null}

      {parameters.length > 0 ? (
        <div data-testid="api-endpoint-params" className="mt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Parameters</p>
          <ul className="mt-1 space-y-1 text-xs leading-5 text-slate-700">
            {parameters.map((parameter) => (
              <li key={`${parameter.in ?? 'query'}:${parameter.name ?? '?'}`} className="flex min-w-0 flex-wrap gap-x-1.5">
                <code className="font-mono text-slate-900">{parameter.name ?? '?'}</code>
                <span className="text-slate-400">
                  {parameter.in ?? 'query'}
                  {parameter.required ? ', required' : ''}
                  {parameter.schema?.type ? `, ${parameter.schema.type}` : ''}
                </span>
                {parameter.description ? <span className="min-w-0 break-words">{parameter.description}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-500">No parameters.</p>
      )}

      {operation.requestBody ? (
        <p className="mt-2 text-xs text-slate-500">
          Request body: <span className="font-mono">application/json</span>
        </p>
      ) : null}

      <div data-testid="api-endpoint-responses" className="mt-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Responses</p>
        <ul className="mt-1 space-y-1 text-xs leading-5 text-slate-700">
          {responses.map(([status, response]) => (
            <li key={status} className="flex min-w-0 gap-1.5">
              <code className="shrink-0 font-mono text-slate-900">{status}</code>
              <span className="min-w-0 break-words text-slate-600">{response.description ?? 'Documented.'}</span>
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

export async function ApiReference() {
  const { data, error } = await getOrError<OpenApiDocument>('/openapi.json');

  if (!data) {
    return (
      <div
        data-testid="api-reference-unavailable"
        className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      >
        <p className="font-semibold">The API reference is unavailable right now.</p>
        <p className="mt-1 max-w-prose text-xs leading-5">
          The document is served by the API at <span className="font-mono">GET /api/v1/openapi.json</span>; the
          console could not read it ({error?.code ?? 'network_error'}: {error?.message ?? 'no response'}). Nothing is
          invented here — start the stack (<span className="font-mono">docker compose up -d</span>) or check{' '}
          <span className="font-mono">GET /health</span>, then reload this page.
        </p>
        <p className="mt-1 text-xs">
          <a
            href="/help/api"
            className="underline decoration-amber-300 underline-offset-2 hover:text-amber-950"
          >
            Reload
          </a>
        </p>
      </div>
    );
  }

  const endpoints = collectEndpoints(data);
  const tagOrder = (data.tags ?? []).map((tag) => tag.name).filter((name): name is string => Boolean(name));
  const resources = [...new Set(endpoints.map((endpoint) => endpoint.resource))].sort((a, b) => {
    const aIndex = tagOrder.indexOf(a);
    const bIndex = tagOrder.indexOf(b);
    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    return a.localeCompare(b);
  });

  return (
    <section data-testid="api-reference" className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">
            {data.info?.title ?? 'OpenAPI document'}
            {data.info?.version ? <span className="ml-2 text-xs font-normal text-slate-500">v{data.info.version}</span> : null}
          </p>
          <p className="text-xs text-slate-500">
            {endpoints.length} operations · OpenAPI <span className="font-mono">{data.openapi ?? '3.1'}</span>
          </p>
        </div>
        <p className="mt-1 max-w-prose text-xs leading-5 text-slate-600">
          Served by the API at <span className="font-mono">GET /api/v1/openapi.json</span>
          {data.servers?.[0]?.url ? (
            <>
              {' '}(server <span className="font-mono">{data.servers[0].url}</span>)
            </>
          ) : null}
          . This page renders that document, so it lists exactly what is served.
        </p>
        <p className="mt-2 text-xs">
          <a
            href="/api/openapi.json"
            data-testid="api-raw-spec"
            className="font-medium text-slate-900 underline decoration-slate-300 underline-offset-2"
          >
            Open the raw OpenAPI document →
          </a>
        </p>
      </div>

      {resources.map((resource) => {
        const rows = endpoints
          .filter((endpoint) => endpoint.resource === resource)
          .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
        const description = (data.tags ?? []).find((tag) => tag.name === resource)?.description;
        return (
          <section key={resource} data-testid="api-resource" data-resource={resource} className="space-y-2">
            <h2 data-testid="api-resource-title" className="text-sm font-semibold text-slate-900">
              {resource} <span className="font-normal text-slate-400">({rows.length})</span>
            </h2>
            {description ? <p className="max-w-prose text-xs text-slate-500">{description}</p> : null}
            <ul className="space-y-2">
              {rows.map((endpoint) => (
                <EndpointCard key={`${endpoint.method}:${endpoint.path}`} endpoint={endpoint} />
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
