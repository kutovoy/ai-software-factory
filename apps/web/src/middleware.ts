import { NextResponse, type NextRequest } from 'next/server';

/**
 * Trailing-slash routing for the local forge (spec `forge` › Served under the console).
 *
 * Forgejo is served at `/extras/forgejo/` and its `ROOT_URL` ends with a slash, so the
 * canonical home page *is* the trailing-slash URL. Next.js normally answers a trailing
 * slash with a 308 before routing; `skipTrailingSlashRedirect` turns that off globally so
 * the forge home reaches the proxy handler, and this middleware restores the default
 * behaviour for every other console route (redirect, exactly as Next did before).
 *
 * A plain `URL` is used instead of `request.nextUrl.clone()`: the cloned `NextURL` keeps
 * the request's trailing-slash state and would re-add the slash, producing a redirect to
 * the very URL that was requested.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (pathname === '/' || !pathname.endsWith('/')) return NextResponse.next();

  const target = new URL(request.url);
  target.pathname = pathname.replace(/\/+$/, '') || '/';

  // The forge owns its trailing-slash URL; rewrite so the proxy renders it.
  if (pathname.startsWith('/extras/forgejo/')) return NextResponse.rewrite(target);
  // Every other console route behaves like stock Next: a trailing slash redirects.
  return NextResponse.redirect(target, 308);
}

export const config = {
  matcher: ['/:path*'],
};
