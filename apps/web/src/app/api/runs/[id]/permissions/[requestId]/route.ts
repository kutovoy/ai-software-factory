import { apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Proxies the inline permission decision from `EventStream` to `POST /runs/:id/permissions/:requestId`. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; requestId: string }> },
): Promise<Response> {
  const { id, requestId } = await context.params;
  const body = await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(
      apiUrl(`/runs/${encodeURIComponent(id)}/permissions/${encodeURIComponent(requestId)}`),
      {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body,
        cache: 'no-store',
      },
    );
  } catch (error) {
    return Response.json(
      {
        code: 'upstream_unavailable',
        message: `cannot reach the API: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 502 },
    );
  }

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  });
}
