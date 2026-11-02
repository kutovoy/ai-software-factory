import { expect, test } from '@playwright/test';
import { factoryId } from './helpers';

const ADMIN_EMAIL = process.env.FACTORY_ADMIN_EMAIL ?? 'admin@factory.local';
const ADMIN_PASSWORD = process.env.FACTORY_ADMIN_PASSWORD ?? 'factory-admin';

const EMPTY_STATE = { cookies: [], origins: [] };

test.describe('signed out', () => {
  test.use({ storageState: EMPTY_STATE });

  test('a protected page redirects to the login page with a next target', async ({ page }) => {
    await page.goto('/users');
    await expect(page).toHaveURL(/\/login\?next=%2Fusers$/);
    await expect(page.getByTestId('login-page')).toBeVisible();
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByTestId('login-email')).toBeVisible();
    await expect(page.getByTestId('login-password')).toBeVisible();
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await expect(page.getByTestId('nav-sidebar')).toHaveCount(0);
  });

  test('a bad password shows invalid_credentials and keeps the form', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('login-email').fill(ADMIN_EMAIL);
    await page.getByTestId('login-password').fill('definitely-not-the-password');
    await page.getByTestId('login-submit').click();

    await expect(page.getByTestId('login-error')).toContainText('Invalid email or password.');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('login-submit')).toBeEnabled();
  });

  test('signing in returns to the requested page', async ({ page }) => {
    await page.goto('/login?next=/users');
    await page.getByTestId('login-email').fill(ADMIN_EMAIL);
    await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
    await page.getByTestId('login-submit').click();

    await expect(page).toHaveURL(/\/users$/);
    await expect(page.getByTestId('users-admin')).toBeVisible();
    await expect(page.getByTestId('nav-user-email')).toHaveText(ADMIN_EMAIL);
  });

  test('signing out revokes the session and returns to the login page', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('login-email').fill(ADMIN_EMAIL);
    await page.getByTestId('login-password').fill(ADMIN_PASSWORD);
    await page.getByTestId('login-submit').click();

    await expect(page).toHaveURL(/\/(chat)?$/);
    await expect(page.getByTestId('nav-user-email')).toHaveText(ADMIN_EMAIL);
    await expect(page.getByTestId('nav-signout')).toBeVisible();
    await page.getByTestId('nav-signout').click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('login-form')).toBeVisible();

    // The revoked cookie must not reopen a protected page.
    await page.goto('/users');
    await expect(page).toHaveURL(/\/login\?next=%2Fusers$/);
  });
});

test.describe('signed in as admin', () => {
  test('the users page lists accounts and manages one', async ({ page }) => {
    await page.goto('/users');
    await expect(page.getByTestId('users-admin')).toBeVisible();
    await expect(page.getByTestId('users-table')).toBeVisible();

    const adminRow = page.getByTestId('user-row').filter({ hasText: ADMIN_EMAIL });
    await expect(adminRow).toBeVisible();
    await expect(adminRow.getByTestId('user-status')).toHaveText('active');

    const stamp = Date.now();
    const email = `e2e-user-${stamp}@factory.local`;
    const username = `e2e-user-${stamp}`;

    await page.getByTestId('user-create-email').fill(email);
    await page.getByTestId('user-create-username').fill(username);
    await page.getByTestId('user-create-name').fill('E2E User');
    await page.getByTestId('user-create-role').selectOption('member');
    await page.getByTestId('user-create-password').fill('e2e-password-123');
    await page.getByTestId('user-create-submit').click();

    await expect(page.getByTestId('users-notice')).toContainText(`Created ${email}`);
    const row = page.getByTestId('user-row').filter({ hasText: email });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('user-username')).toHaveText(username);
    await expect(row.getByTestId('user-status')).toHaveText('active');

    await row.getByTestId('user-role-select').selectOption('admin');
    await expect(page.getByTestId('users-notice')).toContainText(`is now admin`);

    await row.getByTestId('user-toggle-disabled').click();
    await expect(row.getByTestId('user-status')).toHaveText('disabled');
    await expect(page.getByTestId('users-notice')).toContainText(`is now disabled`);

    await row.getByTestId('user-toggle-disabled').click();
    await expect(row.getByTestId('user-status')).toHaveText('active');

    page.once('dialog', (dialog) => void dialog.accept());
    await row.getByTestId('user-delete').click();
    await expect(page.getByTestId('users-notice')).toContainText(`Deleted ${email}`);
    await expect(page.getByTestId('user-row').filter({ hasText: email })).toHaveCount(0);
  });

  /**
   * Factory isolation (change `add-factory-identity`): a member owns no factories, so every
   * factory id belonging to the admin is invisible to them — the API answers 404 (never
   * 403) and the console renders its not-found page rather than leaking the factory.
   */
  test('a member cannot list or open the admin factory', async ({ browser, request }) => {
    const stamp = Date.now();
    const email = `e2e-iso-${stamp}@factory.local`;
    const username = `e2e-iso-${stamp}`;
    const password = 'e2e-password-123';

    const created = await request.post('/api/v1/users', {
      data: { email, username, name: 'E2E Isolation', role: 'member', password },
    });
    expect(created.ok(), `POST /api/v1/users failed: ${created.status()}`).toBeTruthy();
    const userId = ((await created.json()) as { user: { id: string } }).user.id;

    const memberContext = await browser.newContext();
    try {
      const adminFactoryId = await factoryId(request, 'example');
      // The admin can read the factory.
      const adminRead = await request.get(`/api/v1/factories/${adminFactoryId}`);
      expect(adminRead.status()).toBe(200);

      const login = await memberContext.request.post('/api/v1/auth/login', {
        data: { email, password },
      });
      expect(login.ok(), `member login failed: ${login.status()}`).toBeTruthy();

      const list = await memberContext.request.get('/api/v1/factories');
      expect(list.ok()).toBeTruthy();
      const listBody = (await list.json()) as { factories: unknown[] };
      expect(listBody.factories, 'a member owns no factories').toHaveLength(0);

      const foreign = await memberContext.request.get(`/api/v1/factories/${adminFactoryId}`);
      expect(foreign.status(), 'a foreign factory id must 404, never 403').toBe(404);

      const memberPage = await memberContext.newPage();
      await memberPage.goto(`/factories/${adminFactoryId}/dashboard`);
      await expect(memberPage.getByTestId('not-found')).toBeVisible();
    } finally {
      await memberContext.close();
      await request.delete(`/api/v1/users/${userId}`).catch(() => undefined);
    }
  });
});
