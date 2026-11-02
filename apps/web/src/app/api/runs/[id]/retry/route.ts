import { apiUrl, sessionCookieHeader } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Retry-as-new-run proxy (ADR-012: the browser never talks to `apps/api` directly).
 * The API decides eligibility (`run_not_retryable`) and returns the new run id.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const cookie = await sessionCookieHeader();

  let upstream: Response;
  try {
    upstream = await fetch(apiUrl(`/runs/${encodeURIComponent(id)}/retry`), {
      method: 'POST',
      headers: { accept: 'application/json', ...(cookie ? { cookie } : {}) },
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
