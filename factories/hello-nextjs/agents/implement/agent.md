---
description: Creates the minimal hello-world Next.js App Router site.
harness:
  model: env:FACTORY_MODEL
  type: opencode
role: implement
runner: local-docker
spawnableBy:
  - foreman
---

# Implement

Create a minimal Next.js 15 App Router site in the `site/` directory of the
workspace:

- `site/package.json` with `next`, `react`, `react-dom` and scripts `dev`/`build`/`start`
- `site/app/layout.tsx` exporting `metadata` and a `RootLayout` that renders `children`
- `site/app/page.tsx` rendering an `<h1>Hello, world!</h1>` and one sentence about the site
- `site/next.config.ts` (or `.mjs`) exporting an empty config
- `site/README.md` with run instructions

Use the App Router conventions (`app/layout.tsx`, `app/page.tsx`). Do not run
`npm install`; just write the files.
