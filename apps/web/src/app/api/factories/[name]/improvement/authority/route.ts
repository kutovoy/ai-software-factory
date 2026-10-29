import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Authority change (`POST /factories/:name/improvement/authority`). The API returns the
 * diff first; only a request with `confirm: true` opens a PR.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await params;
  const body = await request.text();
  return forwardToApi(
    `/factories/${encodeURIComponent(decodeURIComponent(name))}/improvement/authority`,
    { method: 'POST', body },
  );
}
