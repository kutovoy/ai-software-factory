import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Benchmark run action (estimate, confirm, start) proxied same-origin (ADR-012). The API
 * preserves `cost_confirmation_required`, `benchmark_attestation_missing` and the estimate.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ factory: string; suite: string }> },
): Promise<Response> {
  const { factory, suite } = await context.params;
  const body = await request.text();
  return forwardToApi(
    `/factories/${encodeURIComponent(factory)}/benchmarks/${encodeURIComponent(suite)}/run`,
    { method: 'POST', body },
  );
}
