import { cookies } from 'next/headers';
import { apiUrl } from './api';
import { SESSION_COOKIE } from './auth';

/**
 * Same-origin proxy for browser-side actions (ADR-012: the browser never talks to
 * `apps/api` directly). Route handlers forward verbatim and preserve the API's status and
 * error envelope so the client can branch on stable `code` strings. `apiUrl` applies the
 * `/api/v1` backend prefix; the browser-facing route stays `/api/*`.
 *
 * Console auth (change `add-console-auth`, design decision 5): the incoming
 * `factory_session` cookie is forwarded to the API, and every upstream `Set-Cookie` is
 * copied back — so login/logout work through this same-origin proxy without the browser
 * ever seeing the API host.
 */
export async function forwardToApi(
  path: string,
  init: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: string },
): Promise<Response> {
  const store = await cookies();
  const session = store.get(SESSION_COOKIE)?.value;

  let upstream: Response;
  try {
    upstream = await fetch(apiUrl(path), {
      method: init.method,
      headers: {
        accept: 'application/json',
        ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}),
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

  const headers = new Headers({
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
  });
  // `Set-Cookie` may appear more than once (login sets one; logout clears it). Append all
  // so the browser receives the API's cookie exactly as issued.
  const getSetCookie = (upstream.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  const setCookies =
    typeof getSetCookie === 'function' ? getSetCookie.call(upstream.headers) : [];
  if (setCookies.length === 0) {
    const single = upstream.headers.get('set-cookie');
    if (single) headers.append('set-cookie', single);
  }
  for (const value of setCookies) headers.append('set-cookie', value);

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers,
  });
}
