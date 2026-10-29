import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Stores the GitHub connection by secret *reference* (`POST /integrations/github`). */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  return forwardToApi('/integrations/github', { method: 'POST', body });
}
