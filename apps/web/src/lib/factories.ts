import { cache } from 'react';
import { safeGet } from './api';
import type { FactoryDetail, FactoryListItem } from './types';

/**
 * Request-scoped factory reads. React's `cache()` deduplicates within one server render,
 * so the root layout and a page that both need the factory list make one upstream call
 * instead of two (performance plan, Phase 3). It is deliberately not a cross-request
 * cache: the response is viewer-scoped by the forwarded session cookie.
 */
export const getFactoryList = cache(async () =>
  safeGet<{ factories: FactoryListItem[] }>('/factories', { factories: [] }),
);

export const getFactoryDetail = cache(async (id: string) =>
  safeGet<{ factory: FactoryDetail } | null>(
    `/factories/${encodeURIComponent(id)}`,
    null,
  ),
);
