import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Deletes a registered secret name (`DELETE /secrets/:name`); in-use names are refused. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  return forwardToApi(`/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
}
