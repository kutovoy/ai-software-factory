import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Canary projection (`GET /factories/:name/canary`) for client-side polling. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await params;
  return forwardToApi(`/factories/${encodeURIComponent(decodeURIComponent(name))}/canary`, {
    method: 'GET',
  });
}
