import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** A probe can take a few seconds; keep the route alive long enough for the worker. */
export const maxDuration = 120;

/** Probes a declared MCP server inside the runner (`POST /factories/:name/mcp/:server/test`). */
export async function POST(
  _request: Request,
  context: { params: Promise<{ name: string; server: string }> },
): Promise<Response> {
  const { name, server } = await context.params;
  return forwardToApi(
    `/factories/${encodeURIComponent(name)}/mcp/${encodeURIComponent(server)}/test`,
    { method: 'POST' },
  );
}
