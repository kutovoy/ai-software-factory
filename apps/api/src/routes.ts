/**
 * Path-versioned HTTP surface (ADR-030).
 *
 * One prefix for every public resource route: `/api/v1`. A breaking change bumps the
 * prefix (`/api/v2`) and the old one keeps serving until it is removed deliberately
 * (<https://www.speakeasy.com/api-design/versioning>). `GET /health` stays unversioned
 * because compose probes it and a probe must not have to follow a version bump.
 */
export const API_PREFIX = '/api/v1';

/** The only public route outside the prefix: the liveness probe. */
export const UNVERSIONED_ROUTES = ['/health'] as const;

/**
 * Served but deliberately **not** part of the public, documented surface:
 *  - `/v1/*` is the OpenAI-compatible inference passthrough — its shape is dictated by the
 *    OpenAI SDK, which appends `/chat/completions` to the configured base URL;
 *  - `/internal/*` is a dev/smoke fixture upstream, never enabled in production.
 * They are excluded from `openapi.json` and from the spec/route parity contract test.
 *
 * The dev-only `POST /api/v1/runs/:id/proxy-token` (enabled with `EXPOSE_RUN_TOKEN=1`) is
 * versioned but likewise undocumented: the contract test builds the route table from the
 * production configuration, where that route does not exist.
 */
export const NON_PUBLIC_PREFIXES = ['/v1/', '/internal/'] as const;

/** `path` is a resource path such as `/runs`; returns the public versioned path. */
export function versionedPath(path: string): string {
  if (path === '/' || path === '') return API_PREFIX;
  return `${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
}

/** True when a served route belongs to the documented public surface. */
export function isPublicRoute(path: string): boolean {
  if ((UNVERSIONED_ROUTES as readonly string[]).includes(path)) return true;
  return path.startsWith(`${API_PREFIX}/`);
}

export interface RouteEntry {
  method: string;
  path: string;
}

/** Hono path (`/runs/:id`) → OpenAPI templated path (`/runs/{id}`). */
export function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** A stable, sorted `METHOD path` table — the contract test compares it with the spec. */
export function routeKey(route: RouteEntry): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}
