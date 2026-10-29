import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Manual canary rollback (`POST /canary/rollback`); routing returns to stable immediately. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  return forwardToApi('/canary/rollback', { method: 'POST', body });
}
