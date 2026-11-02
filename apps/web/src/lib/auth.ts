/**
 * Console auth helpers (change `add-console-auth`, spec `console-auth`).
 *
 * `AUTH_REQUIRED` is the single switch shared with `apps/api` (design decision 3). The
 * console reads it at request time so one image can run with auth on or off. `AUTH_REQUIRED`
 * is on in compose and off for local development/unit tests, where the console keeps its
 * old single implicit local user.
 */

/** The HttpOnly session cookie set by `POST /auth/login`. */
export const SESSION_COOKIE = 'factory_session';

/** Pages reachable without a session when `AUTH_REQUIRED=1`. */
export const PUBLIC_PAGES = ['/login', '/help/api', '/favicon.ico'] as const;

/** True when the console must enforce a session (compose sets `AUTH_REQUIRED=1`). */
export function authRequired(): boolean {
  return process.env.AUTH_REQUIRED === '1';
}

export function isPublicPage(pathname: string): boolean {
  return (PUBLIC_PAGES as readonly string[]).includes(pathname);
}

/**
 * Only same-origin absolute paths are valid `next` targets. Rejects `//host` and
 * `https://…` so a crafted link cannot turn sign-in into an open redirect.
 */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return null;
  return next;
}
