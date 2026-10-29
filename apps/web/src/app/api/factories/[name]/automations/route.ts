import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Automation projection: declared triggers + Temporal schedule status (`GET /factories/:name/automations`). */
export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  return forwardToApi(`/factories/${encodeURIComponent(name)}/automations`, { method: 'GET' });
}
