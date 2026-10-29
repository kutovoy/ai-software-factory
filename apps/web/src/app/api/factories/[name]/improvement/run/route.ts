import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** On-demand improvement run (`POST /factories/:name/improvement/run`). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await params;
  const body = await request.text();
  return forwardToApi(`/factories/${encodeURIComponent(decodeURIComponent(name))}/improvement/run`, {
    method: 'POST',
    body,
  });
}
