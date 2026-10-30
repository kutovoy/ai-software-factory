import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The name-only registry projection (`GET /secrets`) — used by client refreshes. */
export async function GET(): Promise<Response> {
  return forwardToApi('/secrets', { method: 'GET' });
}

/** Registers a secret *name* (`POST /secrets`); a value is refused by the API. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  return forwardToApi('/secrets', { method: 'POST', body });
}
