/**
 * The only way the console reaches the platform. Server components and route handlers
 * import this; nothing in the browser talks to `apps/api` directly (no DB, no filesystem,
 * no harness — see ADR-012 and the `web-console` spec).
 */

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

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      accept: 'application/json',
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
