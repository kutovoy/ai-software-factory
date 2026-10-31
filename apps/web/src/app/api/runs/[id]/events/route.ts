import { apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Same-origin SSE proxy. The browser never talks to `apps/api` directly, so there is no
 * CORS preflight and no cross-origin EventSource limitation. `Last-Event-ID` (or the
 * `lastEventId` query the hook uses) is forwarded verbatim so replay is strictly
 * `seq > cursor`; the upstream already sends `x-accel-buffering: no`.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const url = new URL(request.url);
  const lastEventId =
    request.headers.get('last-event-id') ?? url.searchParams.get('lastEventId') ?? '0';

  let upstream: Response;
  try {
    upstream = await fetch(apiUrl(`/runs/${encodeURIComponent(id)}/events`), {
      headers: { accept: 'text/event-stream', 'Last-Event-ID': lastEventId },
      cache: 'no-store',
      signal: request.signal,
    });
  } catch (error) {
    return Response.json(
      {
        code: 'upstream_unavailable',
        message: `cannot reach the API: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => '');
    return new Response(body || JSON.stringify({ code: 'stream_unavailable' }), {
      status: upstream.status || 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}
