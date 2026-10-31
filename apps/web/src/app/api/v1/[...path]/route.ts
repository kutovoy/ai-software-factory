import { apiUrl } from '@/lib/api';

/**
 * Same-origin proxy for the live API explorer (`web-console` spec: "Same-origin API proxy").
 *
 * Swagger UI's "Try it out" runs in the browser, and the OpenAPI document declares the API
 * host as its server. Browsers cannot call that host cross-origin, so every `/api/v1/<path>`
 * request on the console origin is forwarded here — server-side, with the backend prefix
 * applied by `apiUrl` (ADR-030). This is the documented Swagger UI CORS workaround
 * (<https://swagger.io/docs/open-source-tools/swagger-ui/usage/cors/>) and keeps the browser
 * talking to the console only (ADR-012).
 *
 * Status, content type and body are passed through unchanged; the body is streamed so SSE
 * endpoints (`GET /api/v1/runs/:id/events`) stay incremental. Hop-by-hop headers are dropped
 * in both directions, and the upstream is asked for an identity encoding because the runtime
 * decodes compressed bodies itself.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HOP_BY_HOP_REQUEST = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'proxy-authorization',
  'proxy-authenticate',
  'accept-encoding',
]);

const HOP_BY_HOP_RESPONSE = new Set([
  'connection',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'trailer',
]);

interface RouteContext {
  params: Promise<{ path?: string[] }>;
}

async function forward(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const resource = `/${(path ?? []).join('/')}`;
  const query = new URL(request.url).search;
  const target = `${apiUrl(resource)}${query}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_REQUEST.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set('accept-encoding', 'identity');

  const method = request.method.toUpperCase();
  const sendsBody = method !== 'GET' && method !== 'HEAD' && request.body !== null;

  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    cache: 'no-store',
    redirect: 'manual',
    ...(sendsBody ? { body: request.body, duplex: 'half' as const } : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (error) {
    return Response.json(
      {
        code: 'upstream_unavailable',
        message: `cannot reach the API: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_RESPONSE.has(key.toLowerCase())) responseHeaders.set(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
export const HEAD = forward;
export const OPTIONS = forward;
