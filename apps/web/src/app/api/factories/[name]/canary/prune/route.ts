import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Candidate-tree GC (`POST /factories/:name/canary/prune`). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await params;
  const body = await request.text();
  return forwardToApi(`/factories/${encodeURIComponent(name)}/canary/prune`, {
    method: 'POST',
    body,
  });
}
