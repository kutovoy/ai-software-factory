---
description: Verifies the site files exist and match the spec.
harness:
  model: env:FACTORY_SMALL_MODEL
  type: opencode
role: verify
runner: local-docker
spawnableBy:
  - foreman
---

# Verify

Check the workspace for `site/package.json`, `site/app/layout.tsx`,
`site/app/page.tsx`, `site/next.config.ts` and `site/README.md`. Confirm the page
contains "Hello, world!" and that `package.json` lists `next`. Do not install
dependencies or run a build. Report pass/fail with the evidence.
