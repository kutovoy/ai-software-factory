import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Kill switch + lights-off toggle (`POST /autonomy`). */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  return forwardToApi('/autonomy', { method: 'POST', body });
}
