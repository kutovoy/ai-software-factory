import type { Hono } from 'hono';
import { API_PREFIX } from '../src/routes';

/**
 * Test-side path helper. Every public route lives under `/api/v1` (ADR-030), so tests
 * prepend the prefix here instead of hardcoding it at ~70 call sites.
 */
export function v1(path: string): string {
  return `${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
}

/** `app.request` with the version prefix applied. */
export function req(app: Hono, path: string, init?: RequestInit): Response | Promise<Response> {
  return app.request(v1(path), init);
}
