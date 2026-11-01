---
description: Reviews the generated site for correctness and minimal scope.
harness:
  model: env:FACTORY_REVIEW_MODEL
  type: opencode
role: review
runner: local-docker
spawnableBy:
  - foreman
---

# Review

Review the diff. Check that the site uses the App Router (`app/layout.tsx`,
`app/page.tsx`), that `package.json` has valid Next.js/React dependencies and
scripts, and that nothing outside `site/` changed. Report findings; do not edit
files.
