import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, authRequired, isPublicPage } from '@/lib/auth';

/**
 * Console auth gate + trailing-slash routing for the local forge (spec `console-auth` ›
 * Enforcement; spec `forge` › Served under the console).
 *
 * 1. Every request carries `x-pathname`, which the root layout reads to decide whether the
 *    visitor is already on `/login` (no redirect loop).
 * 2. When `AUTH_REQUIRED=1` and there is no `factory_session` cookie, page requests are
 *    redirected to `/login?next=<path>`; `/login`, `/help/api`, Next assets, the favicon,
 *    the same-origin `/api/*` proxy and the forge proxy stay reachable. With auth off this
 *    branch never runs, so local development behaves exactly as before.
 * 3. Forgejo is served at `/extras/forgejo/` and its `ROOT_URL` ends with a slash, so the
 *    canonical home page *is* the trailing-slash URL. Next.js normally answers a trailing
 *    slash with a 308 before routing; `skipTrailingSlashRedirect` turns that off globally so
 *    the forge home reaches the proxy handler, and this middleware restores the default
 *    behaviour for every other console route (redirect, exactly as Next did before).
 *
 * A plain `URL` is used instead of `request.nextUrl.clone()`: the cloned `NextURL` keeps
 * the request's trailing-slash state and would re-add the slash, producing a redirect to
 * the very URL that was requested.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  const headers = new Headers(request.headers);
  headers.set('x-pathname', pathname);

  const isAsset =
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico' ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/extras/forgejo');

  if (authRequired() && !isAsset && !isPublicPage(pathname)) {
    if (!request.cookies.get(SESSION_COOKIE)) {
      const target = new URL('/login', request.url);
      target.searchParams.set('next', `${pathname}${search}`);
      return NextResponse.redirect(target);
    }
  }

  if (pathname === '/' || !pathname.endsWith('/')) {
    return NextResponse.next({ request: { headers } });
  }

  const target = new URL(request.url);
  target.pathname = pathname.replace(/\/+$/, '') || '/';

  // The forge owns its trailing-slash URL; rewrite so the proxy renders it.
  if (pathname.startsWith('/extras/forgejo/')) {
    return NextResponse.rewrite(target, { request: { headers } });
  }
  // Every other console route behaves like stock Next: a trailing slash redirects.
  return NextResponse.redirect(target, 308);
}

export const config = {
  matcher: ['/:path*'],
};
