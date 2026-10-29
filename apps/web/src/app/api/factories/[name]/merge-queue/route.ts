import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Merge queue projection (`GET /factories/:name/merge-queue`). */
export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  return forwardToApi(`/factories/${encodeURIComponent(name)}/merge-queue`, { method: 'GET' });
}
