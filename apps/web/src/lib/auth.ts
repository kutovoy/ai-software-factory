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

export interface AuthGateInput {
  authRequired: boolean;
  pathname: string;
  /** The user resolved by `/auth/me`, or `null` when the API said there is no session. */
  user: unknown | null;
  /** The `/auth/me` failure, or `null` when the API answered. */
  error: { status: number } | null;
}

/**
 * Decide whether a page request must be redirected to sign-in.
 *
 * A failed `/auth/me` is not the same as a signed-out user: when the API is restarting or
 * unreachable the console must keep rendering its shell (with a connection banner) instead
 * of bouncing to `/login`. Only an answered `401/403` or an answered “no user” response
 * redirects; network/5xx failures degrade the page.
 */
export function authGateDecision(input: AuthGateInput): 'render' | 'redirect' {
  if (!input.authRequired || isPublicPage(input.pathname) || input.user) return 'render';
  if (!input.error) return 'redirect';
  if (input.error.status === 401 || input.error.status === 403) return 'redirect';
  return 'render';
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
