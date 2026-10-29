import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Calibration start (`POST /calibration`) for the console. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  return forwardToApi('/calibration', { method: 'POST', body });
}
