import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Creates/pauses Temporal schedules from the definition (`POST /factories/:name/automations/sync`). */
export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { factory?: string };
  const factory = encodeURIComponent(body.factory ?? '');
  return forwardToApi(`/factories/${factory}/automations/sync`, {
    method: 'POST',
    body: JSON.stringify({ factory: body.factory }),
  });
}
