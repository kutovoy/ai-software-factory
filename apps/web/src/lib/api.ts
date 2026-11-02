/**
 * The only way the console reaches the platform. Server components and route handlers
 * import this; nothing in the browser talks to `apps/api` directly (no DB, no filesystem,
 * no harness — see ADR-012 and the `web-console` spec).
 */

import { cookies } from 'next/headers';
import { SESSION_COOKIE } from './auth';

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function apiBaseUrl(): string {
  const configured =
    process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8080';
  return configured.replace(/\/+$/, '');
}

/**
 * Every backend resource lives under one version prefix (ADR-030). Browser-facing
 * same-origin routes stay `/api/*` — this prefix is only applied server-side.
 */
export const API_PREFIX = '/api/v1';

/** Absolute backend URL for a resource path such as `/factories/<id>/runs`. */
export function apiUrl(path: string): string {
  const versioned = path.startsWith(API_PREFIX)
    ? path
    : `${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
  return `${apiBaseUrl()}${versioned}`;
}

interface ErrorEnvelope {
  code?: string;
  message?: string;
  details?: unknown;
}

async function parseError(response: Response): Promise<ApiClientError> {
  let envelope: ErrorEnvelope = {};
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    // non-JSON error body
  }
  return new ApiClientError(
    envelope.code ?? 'http_error',
    response.status,
    envelope.message ?? `request failed with status ${response.status}`,
    envelope.details,
  );
}

/**
 * Forward the browser's `factory_session` cookie on server-side reads/writes. The API
 * authenticates the request; the console never sees the token (it stays HttpOnly in the
 * browser and is passed through here). Auth-off works unchanged: no cookie means the API
 * treats the caller as the implicit local user (design decision 3).
 */
async function sessionCookie(): Promise<{ cookie?: string }> {
  const cookie = await sessionCookieHeader();
  return cookie ? { cookie } : {};
}

/**
 * The `Cookie` header to forward upstream, or `undefined` when the browser has no session.
 * Route handlers that bypass `forwardToApi` (SSE, streaming bodies) use this directly.
 */
export async function sessionCookieHeader(): Promise<string | undefined> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  return value ? `${SESSION_COOKIE}=${value}` : undefined;
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path), {
    cache: 'no-store',
    headers: { accept: 'application/json', ...(await sessionCookie()) },
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: 'POST',
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      ...(await sessionCookie()),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

/** Degraded-mode read: the shell must still render when the API is down. */
export async function safeGet<T>(path: string, fallback: T): Promise<T> {
  try {
    return await apiGet<T>(path);
  } catch {
    return fallback;
  }
}

export interface GetResult<T> {
  data: T | null;
  error: ApiClientError | null;
}

/**
 * Same degraded-mode read as `safeGet`, but keeps the error so a page can say *why* a
 * projection is missing (e.g. a factory directory that is not versioned) instead of
 * pretending the data is empty.
 */
export async function getOrError<T>(path: string): Promise<GetResult<T>> {
  try {
    return { data: await apiGet<T>(path), error: null };
  } catch (error) {
    if (error instanceof ApiClientError) return { data: null, error };
    return {
      data: null,
      error: new ApiClientError('network_error', 0, error instanceof Error ? error.message : String(error)),
    };
  }
}
