import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The MCP projection for a factory (`GET /factories/:name/mcp`). */
export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  return forwardToApi(`/factories/${encodeURIComponent(name)}/mcp`, { method: 'GET' });
}

/** Registers declared MCP servers/bindings in the index (`POST /factories/:name/mcp`). */
export async function POST(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  const body = await request.text();
  return forwardToApi(`/factories/${encodeURIComponent(name)}/mcp`, {
    method: 'POST',
    body: body.length > 0 ? body : undefined,
  });
}
