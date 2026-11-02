import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against the compose stack (`docker compose up -d --build`) with the fake
 * harness, so no model credentials are needed. Override the origin with E2E_BASE_URL.
 *
 *   docker compose up -d --build
 *   cd apps/web && bunx playwright test
 */
export default defineConfig({
  testDir: './e2e',
  // The suite signs in once as the compose bootstrap admin (change `add-console-auth`);
  // auth.spec.ts opts out with an empty storage state for the logged-out scenarios.
  globalSetup: './e2e/global-setup.ts',
  // The audit specs are a manual tool, not part of the CI suite:
  //   UI_AUDIT=1 bunx playwright test audit.spec.ts
  testIgnore: process.env.UI_AUDIT ? [] : ['**/audit*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    storageState: './e2e/.auth/admin.json',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
