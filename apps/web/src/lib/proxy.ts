import { apiBaseUrl } from './api';

/**
 * Same-origin proxy for browser-side actions (ADR-012: the browser never talks to
 * `apps/api` directly). Route handlers forward verbatim and preserve the API's status and
 * error envelope so the client can branch on stable `code` strings.
 */
export async function forwardToApi(
  path: string,
  init: { method: 'GET' | 'POST'; body?: string },
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}${path}`, {
      method: init.method,
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
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
