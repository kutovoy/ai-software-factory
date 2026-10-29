import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Pauses one automation schedule (kill switch for a single cron). */
export async function POST(
  request: Request,
  context: { params: Promise<{ factory: string; automation: string }> },
): Promise<Response> {
  const { factory, automation } = await context.params;
  const body = await request.text();
  return forwardToApi(
    `/factories/${encodeURIComponent(factory)}/automations/${encodeURIComponent(automation)}/pause`,
    { method: 'POST', body },
  );
}
