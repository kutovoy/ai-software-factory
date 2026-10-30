import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Re-registers metadata and bumps the rotation timestamp (`POST /secrets/:name/rotate`). */
export async function POST(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  const body = await request.text();
  return forwardToApi(`/secrets/${encodeURIComponent(name)}/rotate`, {
    method: 'POST',
    body: body.length > 0 ? body : undefined,
  });
}
