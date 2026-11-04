import { cache } from 'react';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { getOrError } from './api';
import { getFactoryList } from './factories';
import type { FactoryDetail } from './types';

/**
 * Resolve the factory behind a `/factories/:id/*` page (change `add-factory-identity`,
 * spec `factory-identity` › URLs carry the id).
 *
 * The API answers `404 factory_not_found` for both an unknown id and a factory owned by
 * someone else — it never leaks existence — so a 404 here renders the not-found page
 * instead of an empty shell. Any other failure (API down, degraded mode) returns `null`
 * and the page keeps its "unavailable" copy.
 */
export const loadFactory = cache(async (id: string): Promise<FactoryDetail | null> => {
  const result = await getOrError<{ factory: FactoryDetail }>(`/factories/${encodeURIComponent(id)}`);
  if (result.error?.status === 404) notFound();
  return result.data?.factory ?? null;
});

/** The human label for a factory page: the definition key, or the id while it loads. */
export function factoryNameOf(detail: FactoryDetail | null, id: string): string {
  return detail?.name ?? id;
}

/**
 * The factory the help pages should link against: the persisted selection, else the first
 * factory the viewer owns. Help content is typed with `/factories/example/...`; the pages
 * rewrite that prefix to a real `fac_<ulid>` id so a "open the page" link is never dead.
 */
export async function helpFactoryId(): Promise<string | null> {
  const [list, cookieStore] = await Promise.all([getFactoryList(), cookies()]);
  const known = new Set(list.factories.map((entry) => entry.id ?? entry.key));
  let persisted: string | null = null;
  try {
    const raw = cookieStore.get('factory')?.value ?? null;
    persisted = raw ? decodeURIComponent(raw) : null;
  } catch {
    persisted = null;
  }
  if (persisted && known.has(persisted)) return persisted;
  return list.factories[0]?.id ?? list.factories[0]?.key ?? null;
}
