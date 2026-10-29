import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Promote a lesson into the shared library (`POST /lessons/:id/promote`). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = await request.text();
  return forwardToApi(`/lessons/${encodeURIComponent(decodeURIComponent(id))}/promote`, {
    method: 'POST',
    body,
  });
}
