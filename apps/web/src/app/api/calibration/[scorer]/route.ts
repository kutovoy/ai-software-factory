import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Calibration status read (`GET /calibration/:scorer?factory=…`) for the console/tests. */
export async function GET(
  request: Request,
  context: { params: Promise<{ scorer: string }> },
): Promise<Response> {
  const { scorer } = await context.params;
  const factory = new URL(request.url).searchParams.get('factory');
  const query = factory ? `?factory=${encodeURIComponent(factory)}` : '';
  return forwardToApi(`/calibration/${encodeURIComponent(scorer)}${query}`, { method: 'GET' });
}
