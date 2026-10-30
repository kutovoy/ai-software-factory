import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Work-item cancellation (`POST /work-items/:id/cancel`). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = await request.text();
  return forwardToApi(`/work-items/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body,
  });
}
