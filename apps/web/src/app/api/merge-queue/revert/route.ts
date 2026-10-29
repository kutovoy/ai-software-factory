import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Manual merge-batch revert (`POST /merge-queue/revert`): a one-shot worker workflow. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  return forwardToApi('/merge-queue/revert', { method: 'POST', body });
}
