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

export interface FactoryListEntry {
  id: string | null;
  key: string;
  name: string;
  owner: string | null;
}

/**
 * The factory list as the given viewer sees it (change `add-factory-identity`). Every
 * factory-scoped route is addressed by the opaque `fac_<ulid>` id, so tests resolve the id
 * from the internal key here instead of hardcoding one.
 */
export async function listFactoriesAs(app: Hono, cookie?: string): Promise<FactoryListEntry[]> {
  const response = await req(app, '/factories', cookie ? { headers: { cookie } } : undefined);
  if (!response.ok) {
    throw new Error(`GET /factories failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { factories: FactoryListEntry[] };
  return body.factories;
}

/** The stable id of the factory with internal key `key`, as seen by the viewer. */
export async function factoryIdOf(app: Hono, key: string, cookie?: string): Promise<string> {
  const factories = await listFactoriesAs(app, cookie);
  const found = factories.find((factory) => factory.key === key);
  if (!found?.id) {
    throw new Error(
      `no factory "${key}" for this viewer (visible: ${factories.map((f) => f.key).join(', ') || 'none'})`,
    );
  }
  return found.id;
}
