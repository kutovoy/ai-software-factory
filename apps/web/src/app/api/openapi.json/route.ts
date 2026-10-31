import { apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Same-origin view of the API's OpenAPI document (`GET /api/v1/openapi.json`). The browser
 * never talks to `apps/api` directly (ADR-012), and the backend prefix stays server-side
 * (`apiUrl`). Byte-identical to the served document, so Swagger UI and Postman can import it
 * from here too.
 *
 * `?servers=console` is the console-targeted variant the explorer loads: it rewrites
 * `servers` to the console origin (`/`), which is where "Try it out" actually sends requests
 * (the catch-all proxy at `src/app/api/v1/[...path]/route.ts`). The canonical document keeps
 * the direct API server so Postman and other Swagger UI consumers still see the real host.
 */

const CONSOLE_SERVERS = [
  { url: '/', description: 'Console origin (same-origin proxy)' },
];

/** The document changes only when the API ships a new spec; a short TTL keeps it cheap. */
const CACHE_TTL_MS = 30_000;
let cache: { body: string; status: number; at: number } | null = null;

async function readUpstream(): Promise<{ body: string; status: number }> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;

  const response = await fetch(apiUrl('/openapi.json'), {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  const entry = { body: await response.text(), status: response.status, at: Date.now() };
  if (response.ok) cache = entry;
  return entry;
}

function jsonResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

export async function GET(request: Request): Promise<Response> {
  const servers = new URL(request.url).searchParams.get('servers');

  let upstream: { body: string; status: number };
  try {
    upstream = await readUpstream();
  } catch (error) {
    return Response.json(
      {
        code: 'upstream_unavailable',
        message: `cannot reach the API: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 502 },
    );
  }

  // The default view is the served document, untouched.
  if (servers !== 'console' || upstream.status !== 200) return jsonResponse(upstream.body, upstream.status);

  let document: Record<string, unknown>;
  try {
    document = JSON.parse(upstream.body) as Record<string, unknown>;
  } catch {
    return Response.json(
      { code: 'invalid_document', message: 'the API returned a document that is not JSON' },
      { status: 502 },
    );
  }

  return Response.json(
    { ...document, servers: CONSOLE_SERVERS },
    { headers: { 'cache-control': 'no-store' } },
  );
}
