# Proposal

## Why

The runtime works headless, but the product's defining claim is that **the web UI is the harness
front-end**. Phase 2b builds that console: full nav parity with the reference product, live streaming
chat, runs, and an inbox where humans act. It is also the first place the lights-on/off model becomes
visible (gate display), even though gate *decisions* ship in Phase 3.

## What Changes

- Add `apps/web`: Next.js App Router + Tailwind, no component library.
- Add factory read endpoints to `apps/api` (list, detail, resources, versions, diff) backed by
  `@factory/core` + git.
- Build the nav shell with full parity: New Chat, Inbox, Runs, MCPs and apps, Secrets, Users, and a
  per-factory group (Dashboard, Agents, Automations, Scorers, Self-improvement, Benchmarks, Definition,
  Gates, Settings).
- Build the core loop screens: New Chat (streaming), Runs list, Run detail (live SSE + replay), Inbox
  (pending permissions, failed runs).
- Add `apps/web` to `compose.yaml` and extend `scripts/smoke.sh` with a web health check.
- Add a Playwright E2E suite covering the core loop.

## Capabilities

### New Capabilities
- `web-console`: the browser application — navigation, live run rendering, chat, inbox, and factory
  read-only pages — with a tested streaming contract.

### Modified Capabilities
<!-- none: API additions are read-only projections of factory-definition -->

## Impact

- New app: `apps/web`; new API routes under `/factories/*`.
- New dev deps: `next`, `react`, `tailwindcss`, `@playwright/test`.
- Compose gains a `web` service; smoke gains a web check; CI gains a Playwright job.
- No schema changes; no new runtime services.
