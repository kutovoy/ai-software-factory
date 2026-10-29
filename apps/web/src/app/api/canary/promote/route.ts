import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Manual canary promotion (`POST /canary/promote`); merges the candidate PR. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  return forwardToApi('/canary/promote', { method: 'POST', body });
}
