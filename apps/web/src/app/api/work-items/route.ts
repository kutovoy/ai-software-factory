import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** `GET /work-items` (board / inbox polling) and `POST /work-items` (manual creation). */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.toString();
  return forwardToApi(`/work-items${query ? `?${query}` : ''}`, { method: 'GET' });
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  return forwardToApi('/work-items', { method: 'POST', body });
}
