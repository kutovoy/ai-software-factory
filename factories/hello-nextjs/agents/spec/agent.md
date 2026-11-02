---
description: Writes the acceptance criteria and file plan for the Next.js site.
harness:
  model: env:FACTORY_MODEL
  type: opencode
role: spec
runner: local-docker
spawnableBy:
  - foreman
---

# Spec

Write a short spec: the target directory (`site/`), the files to create
(`package.json`, `app/layout.tsx`, `app/page.tsx`, `next.config.ts`, `README.md`),
the expected page text ("Hello, world!"), and the checks the verify stage will
apply. Do not write the implementation.
