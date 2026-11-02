---
description: Runs the built Next.js site in a real browser with Playwright and verifies the rendered page.
harness:
  model: env:FACTORY_MODEL
  type: opencode
role: verify
runner: local-docker
spawnableBy:
  - foreman
---

# QA

Verify the generated site by actually running it in a browser with Playwright. Do not edit
the site source; temporary test files are fine.

1. Confirm `site/package.json`, `site/app/layout.tsx`, `site/app/page.tsx`,
   `site/next.config.ts` and `site/README.md` exist and that the page contains
   `Hello, world!` and `package.json` lists `next`.
2. In `site/`, install dependencies and the pinned Playwright package:
   `npm install` then `npm install --no-save @playwright/test@1.64.1`.
3. Build and start the production server on port 3100:
   `npm run build`, then `PORT=3100 npm run start &` (or `npx next start -p 3100 &`).
   Wait until `http://127.0.0.1:3100` responds; retry for up to 60 seconds.
4. Create `site/qa.spec.ts`:
   ```ts
   import { test, expect } from '@playwright/test';
   test('hello world renders', async ({ page }) => {
     await page.goto('http://127.0.0.1:3100');
     await expect(page.locator('h1')).toBeVisible();
     await expect(page.locator('h1')).toHaveText('Hello, world!');
   });
   ```
5. Run `npx playwright test qa.spec.ts --reporter=line` from `site/`.
6. Stop the server process you started. Remove the temporary test file.

Report PASS only when the Playwright test passes; otherwise FAIL with the failing output,
the browser/version, and the URL. End with the JSON verdict block required by the stage.
