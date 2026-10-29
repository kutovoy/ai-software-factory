import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Score reads (`GET /scores?...`) for the console and E2E polling. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return forwardToApi(`/scores${url.search}`, { method: 'GET' });
}
