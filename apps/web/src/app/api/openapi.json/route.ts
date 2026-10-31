import { forwardToApi } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Same-origin view of the API's OpenAPI document (`GET /api/v1/openapi.json`). The browser
 * never talks to `apps/api` directly (ADR-012), and the backend prefix stays server-side
 * (`forwardToApi` → `apiUrl`). Byte-identical to the served document, so Swagger UI and
 * Postman can import it from here too.
 */
export async function GET(): Promise<Response> {
  return forwardToApi('/openapi.json', { method: 'GET' });
}
