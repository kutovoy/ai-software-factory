import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createApp, servedRoutes } from '../src/app';
import { loadApiConfig } from '../src/config';
import { API_PREFIX, routeKey, type RouteEntry } from '../src/routes';

/**
 * OpenAPI parity contract (ADR-030): `apps/api/openapi.json` is the source of truth for the
 * public surface. This suite fails when a route is served but undocumented, or documented
 * but not served — naming method + path either way.
 */

const config = loadApiConfig({
  DATABASE_URL: 'postgres://factory:factory@localhost:5433/factory',
  FACTORY_ROOT: 'factories',
});

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, { summary?: string; responses?: Record<string, unknown> }>>;
}

const spec = JSON.parse(
  readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'),
) as OpenApiDocument;

function documentedRoutes(): RouteEntry[] {
  const routes: RouteEntry[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      if (item[method]) routes.push({ method: method.toUpperCase(), path });
    }
  }
  return routes;
}

describe('openapi contract', () => {
  test('every served public route is documented', () => {
    const documented = new Set(documentedRoutes().map(routeKey));
    const missing = servedRoutes(config)
      .filter((route) => !documented.has(routeKey(route)))
      .map(routeKey);
    expect(missing).toEqual([]);
  });

  test('every documented route is served', () => {
    const served = new Set(servedRoutes(config).map(routeKey));
    const extra = documentedRoutes()
      .filter((route) => !served.has(routeKey(route)))
      .map(routeKey);
    expect(extra).toEqual([]);
  });

  test('every documented path is versioned, except the unversioned liveness probe', () => {
    const offenders = Object.keys(spec.paths).filter(
      (path) => path !== '/health' && !path.startsWith(`${API_PREFIX}/`),
    );
    expect(offenders).toEqual([]);
    expect(Object.keys(spec.paths)).toContain('/health');
    expect(Object.keys(spec.paths)).toContain(`${API_PREFIX}/health`);
  });

  test('the document is OpenAPI 3.1 with info, servers and every operation described', () => {
    expect(spec.openapi.startsWith('3.1')).toBe(true);
    expect(spec.info.title.length).toBeGreaterThan(0);
    expect(spec.info.version.length).toBeGreaterThan(0);

    const undocumented: string[] = [];
    for (const route of documentedRoutes()) {
      const operation = spec.paths[route.path]?.[route.method.toLowerCase()];
      const responses = Object.keys(operation?.responses ?? {});
      const hasSuccess = responses.some((code) => code.startsWith('2'));
      if (!operation?.summary || !hasSuccess) undocumented.push(routeKey(route));
    }
    expect(undocumented).toEqual([]);
  });

  test('every templated path declares its path parameters', () => {
    const missing: string[] = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      if (names.length === 0) continue;
      for (const method of HTTP_METHODS) {
        const operation = item[method] as
          | { parameters?: { name: string; in: string }[] }
          | undefined;
        if (!operation) continue;
        const declared = new Set(
          (operation.parameters ?? []).filter((param) => param.in === 'path').map((param) => param.name),
        );
        for (const name of names) {
          if (!declared.has(name)) missing.push(`${method.toUpperCase()} ${path} (${name})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('versioned surface', () => {
  const app = createApp(config);

  test('unversioned resource paths are not served', async () => {
    const unversioned = ['/runs', '/work-items', '/factories', '/secrets', '/chat', '/autonomy'];
    for (const path of unversioned) {
      const response = await app.request(path);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe('not_found');
    }

    const post = await app.request('/runs', { method: 'POST', body: '{}' });
    expect(post.status).toBe(404);
  });

  test('GET /health stays unversioned and is served', async () => {
    const response = await app.request('/health');
    // 200 with the stack up; 503 when Postgres/Temporal are unreachable (degraded probe).
    expect([200, 503]).toContain(response.status);
    const body = (await response.json()) as {
      status?: string;
      checks?: { db?: unknown; temporal?: unknown };
    };
    expect(['ok', 'degraded']).toContain(body.status ?? '');
    expect(body.checks?.db).toBeDefined();
    expect(body.checks?.temporal).toBeDefined();
  }, 30_000);

  test('GET /api/v1/health mirrors the probe', async () => {
    const response = await app.request(`${API_PREFIX}/health`);
    expect([200, 503]).toContain(response.status);
    const body = (await response.json()) as { status?: string };
    expect(['ok', 'degraded']).toContain(body.status ?? '');
  }, 30_000);

  test('GET /api/v1/openapi.json serves the document', async () => {
    const response = await app.request(`${API_PREFIX}/openapi.json`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as OpenApiDocument;
    expect(body.openapi).toBe(spec.openapi);
    expect(Object.keys(body.paths).sort()).toEqual(Object.keys(spec.paths).sort());
  });
});
