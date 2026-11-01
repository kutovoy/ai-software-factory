import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Work-item retry (`POST /work-items/:id/retry`). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = await request.text();
  return forwardToApi(`/work-items/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    body,
  });
}
