import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Autonomy read model (`GET /autonomy?factory=`). */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const factory = url.searchParams.get('factory');
  const query = factory ? `?factory=${encodeURIComponent(factory)}` : '';
  return forwardToApi(`/autonomy${query}`, { method: 'GET' });
}

/** Kill switch + lights-off toggle (`POST /autonomy`). */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  return forwardToApi('/autonomy', { method: 'POST', body });
}
