import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Accept/reject a proposal (`POST /proposals/:id/decision`). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = await request.text();
  return forwardToApi(`/proposals/${encodeURIComponent(decodeURIComponent(id))}/decision`, {
    method: 'POST',
    body,
  });
}
