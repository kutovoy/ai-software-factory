import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Read-only integration projection (`GET /factories/:name/integrations`). */
export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  return forwardToApi(`/factories/${encodeURIComponent(name)}/integrations`, { method: 'GET' });
}
