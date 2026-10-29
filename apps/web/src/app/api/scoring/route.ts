import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** On-demand scoring (`POST /scoring`). The browser never calls the API directly (ADR-012). */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  return forwardToApi('/scoring', { method: 'POST', body });
}
