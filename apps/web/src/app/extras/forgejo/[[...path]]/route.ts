import { NextResponse } from 'next/server';
import { apiUrl } from '@/lib/api';
import { authRequired } from '@/lib/auth';

/**
 * Same-origin proxy for the local forge (spec `forge` › Served under the console).
 *
 * Forgejo is configured with `ROOT_URL=http://localhost:3000/extras/forgejo/` and
 * `STATIC_URL_PREFIX=/extras/forgejo`, so every link and asset it generates already
 * carries the subpath. This handler strips the prefix, forwards the request to the forge
 * on the compose network and — crucially — asserts the identity with the trusted
 * `X-WebAuth-User` header (Forgejo `ENABLE_REVERSE_PROXY_AUTHENTICATION`). A plain
 * `next.config` rewrite cannot add a request header, and the header is what makes
 * single-user auto-login work, so the proxy lives here (ADR-032).
 *
 * The forge is not published on a host port: it is reachable only from the compose
 * network, so a browser cannot send the header itself.
 *
 * Streaming matters for git-over-HTTP (`git clone http://localhost:3000/extras/forgejo/
 * <org>/<repo>.git`): the request body is piped through untouched and the upstream body is
 * returned as a stream. Hop-by-hop headers are dropped in both directions and the upstream
 * is asked for an identity encoding because the runtime decodes compressed bodies itself.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Where the forge listens inside the compose network. Server-side only. */
const FORGE_URL = (process.env.FORGEJO_URL ?? 'http://forgejo:3000').replace(/\/+$/, '');
/** Fallback identity asserted by the proxy when auth is off. */
const ADMIN_USER = process.env.FORGEJO_ADMIN_USER ?? 'factory';
/** Public prefix the forge believes it is served under. */
const PREFIX = '/extras/forgejo';

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
  // Never trust an identity header that arrives from the browser: the proxy owns it.
  'x-webauth-user',
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

function forgeUnavailable(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'unknown error';
  return NextResponse.json(
    {
      code: 'forge_unavailable',
      message: `the local forge is not reachable at ${FORGE_URL}`,
      detail: message,
      hint: 'start it with `docker compose up -d forgejo` (enabled by default)',
    },
    { status: 502 },
  );
}

/**
 * Resolve the signed-in console user through the API's public `/auth/me` route, forwarding
 * the browser's `factory_session` cookie. Auth-off also returns `{user:null}`, which the
 * caller turns into the seeded-admin fallback (spec `forge-identity` › Auth disabled).
 */
async function sessionUsername(request: Request): Promise<string | null> {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  try {
    const response = await fetch(apiUrl('/auth/me'), {
      headers: { accept: 'application/json', cookie },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { user?: { username?: string } | null };
    return body.user?.username ?? null;
  } catch {
    return null;
  }
}

function loginRedirect(request: Request): Response {
  const url = new URL(request.url);
  const target = new URL('/login', url);
  target.searchParams.set('next', `${url.pathname}${url.search}`);
  return NextResponse.redirect(target);
}

async function forward(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const resource = `/${(path ?? []).join('/')}`;
  const query = new URL(request.url).search;
  const target = `${FORGE_URL}${resource}${query}`;

  const authOn = authRequired();
  const sessionUser = await sessionUsername(request);
  if (authOn && !sessionUser) {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') return loginRedirect(request);
    return NextResponse.json(
      {
        code: 'auth_required',
        message: 'sign in to use the local forge',
        hint: 'open the console, sign in, then reload the forge',
      },
      { status: 401 },
    );
  }
  // The proxy is the only trusted client of the forge; assert the signed-in user, or the
  // seeded admin when auth is off (single-user mode).
  const forgeUser = sessionUser ?? ADMIN_USER;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_REQUEST.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set('accept-encoding', 'identity');
  headers.set('x-webauth-user', forgeUser);

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
    return forgeUnavailable(error);
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP_RESPONSE.has(key.toLowerCase())) return;
    // Forgejo already emits prefixed locations (ROOT_URL carries the subpath); a location
    // that lost the prefix would send the browser straight to the unpublished forge port.
    if (key.toLowerCase() === 'location' && value.startsWith('/') && !value.startsWith(PREFIX)) {
      responseHeaders.set(key, `${PREFIX}${value}`);
      return;
    }
    responseHeaders.set(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = forward;
export const HEAD = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
export const OPTIONS = forward;
