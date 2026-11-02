import { apiUrl, sessionCookieHeader } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const body = await request.text();
  const cookie = await sessionCookieHeader();

  let upstream: Response;
  try {
    upstream = await fetch(apiUrl(`/runs/${encodeURIComponent(id)}/cancel`), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: body.length > 0 ? body : JSON.stringify({ reason: 'cancelled from console' }),
      cache: 'no-store',
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

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  });
}
