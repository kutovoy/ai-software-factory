import { request, type FullConfig } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Logs in once as the compose bootstrap admin and saves the resulting `factory_session`
 * cookie as Playwright's `storageState`. Every spec then starts signed in (spec
 * `console-auth` › Enforcement), while `auth.spec.ts` opts out with an empty state.
 *
 * Credentials come from the same env names the API reads; the compose defaults are local
 * development only (see SECURITY.md).
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL =
    config.projects[0]?.use?.baseURL ??
    process.env.E2E_BASE_URL ??
    'http://localhost:3000';
  const email = process.env.FACTORY_ADMIN_EMAIL ?? 'admin@factory.local';
  const password = process.env.FACTORY_ADMIN_PASSWORD ?? 'factory-admin';

  const context = await request.newContext({ baseURL });
  try {
    const response = await context.post('/api/v1/auth/login', {
      data: { email, password },
    });
    if (!response.ok()) {
      throw new Error(
        `E2E login failed (${response.status()}) for ${email}: ${await response.text()}. ` +
          'Set FACTORY_ADMIN_EMAIL / FACTORY_ADMIN_PASSWORD to match the API bootstrap admin.',
      );
    }

    const directory = path.join(process.cwd(), 'e2e', '.auth');
    await mkdir(directory, { recursive: true });
    await context.storageState({ path: path.join(directory, 'admin.json') });
  } finally {
    await context.dispose();
  }
}
