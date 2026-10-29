import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Proxies a gate decision to `POST /work-items/:id/gates/:stage` (Temporal Update). */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; stage: string }> },
): Promise<Response> {
  const { id, stage } = await context.params;
  const body = await request.text();
  return forwardToApi(
    `/work-items/${encodeURIComponent(id)}/gates/${encodeURIComponent(stage)}`,
    { method: 'POST', body },
  );
}
