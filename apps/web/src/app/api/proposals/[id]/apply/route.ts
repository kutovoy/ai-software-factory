import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Apply an accepted proposal by its recorded authority (`POST /proposals/:id/apply`). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = await request.text();
  return forwardToApi(`/proposals/${encodeURIComponent(decodeURIComponent(id))}/apply`, {
    method: 'POST',
    body,
  });
}
