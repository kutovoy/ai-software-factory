import { apiUrl, sessionCookieHeader } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Creates a chat run through the versioned `POST /api/v1/chat`; the client then subscribes to the run stream. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const cookie = await sessionCookieHeader();

  let upstream: Response;
  try {
    upstream = await fetch(apiUrl('/chat'), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body,
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
