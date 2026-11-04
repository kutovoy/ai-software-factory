# Handover

State as of 2026-11-03. Everything below is committed and tagged. Public-release prep: `README.md`, `LICENSE`
(MIT, © Nick Kutovyy), `NOTICE` (attribution request), `SECURITY.md`, `CONTRIBUTING.md`.

## What exists

| Layer | Location | Notes |
|---|---|---|
| Definition schema + CLI | `packages/core`, `packages/cli` | `factory validate/export/import/diff/fmt/version`, canonical YAML, semantic diff, git version pinning |
| Harness adapters | `packages/adapters` | canonical `FactoryEvent`, `FakeAdapter`, opencode adapter (installed v2 API, v1-tolerant) |
| Runners | `packages/runners` | Docker + local backends; harness runs *inside* the sandbox; secret boundary |
| Orchestration | `packages/orchestration` | Temporal: `RunWorkflow`, `FactoryWorkflow`, `StageWorkflow`, `ScoringWorkflow`, `BenchmarkWorkflow`, `ImprovementWorkflow`, `CanaryWorkflow`, `MergeQueueWorkflow` |
| Code forges | `packages/forge` | `CodeForge` contract, fake + GitHub (token by ref, dry-run, offline contract tests) |
| Merge queue | `packages/merge` | serialized merge train, bisect on red, single-commit revert, manual revert |
| Evals | `packages/evals` | scorers (deterministic + judge), calibration, benchmarks, Pareto, self-improvement, lessons |
| API | `apps/api` | path-versioned under `/api/v1` (ADR-030); OpenAPI 3.1 at `GET /api/v1/openapi.json`; every factory-scoped resource nested under `/api/v1/factories/<factoryId>/…` (runs/SSE, permissions, chat, work items, gates, autonomy, readiness, guard hooks, scores, calibration, scoring, benchmarks, improvement, proposals, lessons, canary, MCPs, merge queue, automations); global factories/auth/secrets/integrations/webhooks |
| Web console | `apps/web` | full nav parity; global chat/inbox/secrets/users/help; factory pages nested under `/factories/<id>/…` including readiness, score detail and MCPs; work-item validation contract panel; Factory Stack help |
| Examples | `factories/example`, `factories/example-lights-off` | lights-on (spec/plan/PR human) vs canary authority |

## Run it

```bash
docker compose up -d --build      # postgres + temporal + api + worker + web
bash scripts/smoke.sh             # full credential-free smoke (16 sections)
cd apps/web && bunx playwright test   # 61 E2E flows
bun run ci                        # typecheck + unit/integration-off + factory validation

# the API surface: one version prefix, /health stays unversioned
curl -s localhost:8080/health                 # liveness probe
curl -s localhost:8080/api/v1/health          # same body, versioned
curl -s localhost:8080/api/v1/openapi.json    # the contract (Swagger UI / Postman)
curl -s localhost:8080/api/v1/factories       # factory list (id + owner + key)
curl -s localhost:8080/api/v1/factories/<factory-id>/runs   # factory-scoped resources are nested
```

Forge transport (spec `forge-transport`): HTTP through the console proxy, git over SSH on the published port,
and an opt-in websocket proxy.

```bash
# HTTP: the console proxy (auto-login as the signed-in user)
git clone http://localhost:3000/extras/forgejo/acme/hello-nextjs.git
# SSH: built-in server, host keys persisted in forgejo-data; add a key in Forgejo → Settings → SSH keys
git clone ssh://git@localhost:2222/acme/hello-nextjs.git
ssh -p 2222 git@localhost                     # reaches the forge's SSH server (auth fails without a key)
# optional websocket mode: console on :3000, forge on http://localhost:3001 via Caddy
docker compose -f compose.yaml -f compose.proxy.yaml up -d
curl -s -b /tmp/factory-cookies.txt localhost:8080/api/v1/auth/forge-identity  # 200 + X-WebAuth-User
```

Integration suites (need compose up) default to the separate `factory_test` database
(created by `scripts/postgres-init.sql`; on an existing volume run
`create database factory_test owner factory` once):
```bash
TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 bun test <file>
# DATABASE_URL=postgres://... overrides the factory_test default.
```
`scripts/smoke.sh` prints its target database, pauses the nightly schedule it syncs and
deletes the throwaway secret it registers. `bash scripts/reset-dev.sh --yes` clears
smoke/e2e/demo rows explicitly.

## Point it at your own model

The sandbox never sees provider credentials (ADR-011). Set in `.env`:

```
OPENAI_BASE_URL=http://host.docker.internal:4000/v1   # your LiteLLM
OPENAI_API_KEY=sk-...                                 # provider key, stays in api/worker
FACTORY_MODEL=best_llm                                # foreman/spec/implement
FACTORY_SMALL_MODEL=best_llm                          # triage/verify
FACTORY_REVIEW_MODEL=best_llm                         # review
```

The example definitions declare `model: env:FACTORY_*` (ADR-028), so the concrete model is
configuration. `factory validate` prints every resolved model; an unset variable is a warning,
and starting a run with it is refused with `model_unresolved`.

The API mints a per-run `rsk_…` token, injects the real key only outside the sandbox, and revokes it at run
end. Harnesses receive `OPENAI_BASE_URL=<proxy>/v1` + the run token.

## Real GitHub

Set `GITHUB_TOKEN` (fine-grained PAT: repo, pull_request, checks) and enable the integration via
`POST /api/v1/integrations/github` or the Settings page; configure the webhook URL + secret name. `GITHUB_DRY_RUN=1`
lets you validate wiring without touching a repo. GitHub delivers to
`${WEBHOOK_PUBLIC_URL}/api/v1/webhooks/github` (the Settings page shows the exact URL).

## Known gaps / next

1. **Phase 6c**: external OIDC/IdP group→org mappings, remote runners, Temporal Cloud, per-tenant isolation.
2. **Live GitHub path**: implemented and contract-tested, not exercised against a real repo.
3. **Forge proxy mode**: SSH ships by default; the Caddy overlay is live-validated for session auth and HTTP,
   but a websocket upgrade has not been exercised end to end.
4. **Promotion** merges the definition repo but does not rewrite the local checkout; `runs/canary/` GC is manual.
5. **Factory engineering foundation** is implemented on `feat/factory-engineering-foundation`: validation
   contract + QA pyramid, agent readiness, outcome metrics, guard hooks and Factory Stack help. Remaining roadmap
   in `research/software-factory-ideas.md`: trace-driven self-improvement, model routing, work intake,
   progressive context, governance, surface-agnostic agents and missions.
6. **Read-path performance**: `/inbox` ~7s and `/work-items` ~3.5–4s on the compose stack; SQL is fast, but
   registry sync and N+1 detail reads dominate. The grounded phased fix plan is in `docs/PERFORMANCE.md`
   (not implemented).

## Version tags

`factory-v0` (definition schema) · `phase-2a` (runtime) · `phase-2b` (console) · `phase-3a` (loop) ·
`phase-3b` (GitHub + merge queue) · `phase-4a` (scoring) · `phase-4b` (benchmarks) · `phase-5` (self-improvement) ·
`harden-runtime` · `secrets-mcp` · `api-v1-help` · `help-center` · `live-api-explorer` · `api-explorer-parity` ·
`fix-ui-audit` · `fix-run-failures` · `run-actions` · `readiness-hello-nextjs` · `console-ops` · `forgejo` ·
`agent-verdicts` · `console-auth` · `harden-runners` · `forge-ssh-public` · `factory-identity` · `factory-purge` ·
`readiness-identity` · `unify-factory-api` · `fix-forge-pr-files` · `readiness-forge-files`.

## Latest state (2026-11-03)

- **Factory engineering foundation**: work items get a persisted validation contract (unit/component/
  integration/e2e/manual); the verify gate refuses approval while enforced evidence is missing; readiness
  scores the checkout and definition; metrics add human interactions per PR, autonomy ratio, cost per accepted
  change, signal-to-production cycle time, incident MTT and merged-code age; pure guard hooks run before a PR
  commit; Help explains the 00–06 factory stack. Train-game opts into enforced validation and guard hooks.

## Previous state (2026-11-01)

- **Readiness PASS**: `hello-nextjs` (six agents, all gates `agent`, `auto_on_green`, audited autonomy override)
  took `wi_01M6B5097TGHK0KKZQN9BB3C4G` to `done` with zero human decisions and a merged PR containing the five
  `site/` files. Fixes: prompt delivery, factory-agent identity, patch capture for untracked files, downstream
  patch application, work-item retry, contextual run actions.
- **Agent verdicts**: agent-gated stages ask for a fenced JSON verdict; structured and textual FAIL signals can
  request changes/reject without a human, and `agentVerdict: required` makes a missing verdict a request-changes.
  Verdicts are stored on `gate_decisions` and shown in the inbox.
- **Console auth**: users/sessions (migration 016), argon2id, hashed opaque tokens, HttpOnly `factory_session`,
  `AUTH_REQUIRED=1` in compose, bootstrap admin, `/login`, real Users page (create, role, disable, delete with
  self/last-admin guards), admin/member roles, per-user work-item/run scope. The Forgejo proxy asserts the
  signed-in username; each user gets org `u-<username>`.
- **Runner hardening**: Linux `bwrap` sandbox (ro-root, rw workspace, optional network unshare), explicit
  `runner.sandbox_unavailable` when missing; recorded replay for benchmark trials (`replayFrom: run_…`); hydration
  mismatch fixed via `TimeAgo`.
- **Second lights-off run (2026-11-02)**: `hello-nextjs` recreated with a Playwright QA verify agent. Runner image
  bakes `@playwright/test@1.64.1` + Chromium; work item `wi_01M6D66NASJ95RN86JVTZKTBF0` reached `done` with zero
  human decisions and merged PR #4. The opencode adapter now carries the last assistant message as the run
  summary, so `agentVerdict: required` gates can parse the structured verdict.
- **Factory identity + purge v2 (2026-11-02)**: committed `fac_<ulid>` IDs, owner-scoped paths, nested-only
  `/factories/<id>/…` URLs and `/api/v1/factories/:factoryId/…` API; members are scoped to their own factories
  (404 otherwise). `DELETE /api/v1/factories/:factoryId` is a verified hard purge (DB rows, Temporal schedules,
  running workflows, run dirs; git/forge kept). A fresh run `wi_01M6DF5HG9EMWWPKN4JB4YGCDG` merged PR #5 with
  Playwright QA passing (`1 passed (687ms)`).
- **Unified factory paths (2026-11-02)**: every factory-scoped API resource (scores, calibration, scoring,
  benchmark/improvement detail, proposals, lessons, webhook deliveries) now lives under
  `/api/v1/factories/:factoryId/…`; no `?factory=` remains. Browser score detail and MCPs moved to
  `/factories/<id>/scores/<id>` and `/factories/<id>/mcps`. No DB migration; breaking `/api/v1` rewrite recorded
  in ADR-039.
- **Forge PR content fix (2026-11-02)**: `forgeOpenPullRequest` now applies the implement patch to the base
  branch snapshot and commits the resulting files; it no longer commits `changes/<workItem>.patch`. The clean
  Forgejo repo's PR #1 contains the actual `site/` Next.js code and QA Playwright passed (`1 passed (635ms)`).
- **Graphite Command shell (2026-11-03)**: the sidebar is a dark graphite rail with teal active states and
  icon + label rows; it starts expanded and collapses to an 80px icon strip. The nav has no visible scrollbar,
  API/Help live in the main menu, and the unclear “Usage available” placeholder is gone. The sticky header is
  dark with a breadcrumb, auto-refresh, and Help at the top right. The account block (role, sign-out, GitHub
  link) stays in the sidebar footer.
- **Local forge**: Forgejo at `http://localhost:3000/extras/forgejo/`, enabled by default, proxied by the console
  and asserting the signed-in user (admin fallback when auth is off). Bootstrap:
  `bash scripts/forgejo-bootstrap.sh` (admin, token to `.env`, org/repo). The forge client speaks Gitea's dialect;
  PR URLs resolve.
  - **SSH** (spec `forge-transport` › SSH access): the built-in server listens on `:22` in the container, published
    as `localhost:2222`; `SSH_PORT=2222`/`SSH_DOMAIN=localhost` make clone URLs
    `ssh://git@localhost:2222/<org>/<repo>.git`. Host keys live under `/data/gitea/ssh` in `forgejo-data`.
    The image's own OpenSSH s6 service is masked (`tmpfs: /etc/s6/openssh`) so the two servers do not fight for
    port 22. Keys are not seeded: add one in Forgejo → Settings → SSH keys.
  - **Optional websocket proxy**: `docker compose -f compose.yaml -f compose.proxy.yaml up -d` adds Caddy on
    `http://localhost:3001` (`Caddyfile`), points the forge's ROOT_URL at that origin with an empty static prefix,
    and reverse-proxies everything including upgrades. Auth stays: Caddy's `forward_auth` calls
    `GET /api/v1/auth/forge-identity` (200 + `X-WebAuth-User`, 401 when signed out) and copies the header to the
    forge. The console stays on `:3000`; this mode is opt-in, the default single-origin setup is unchanged.
  - Multi-user OIDC group mapping is still deferred.
- **Console**: auto-refresh (15s, off on help), operational dashboard (state/work/runs/deliverables), persisted
  factory selection by `fac_<ulid>` id, factory-scoped work-items board and runs list with status filters and
  timestamps. URLs are `/factories/<id>/…` only; the old `/work-items` and `/runs` pages are gone.
- **API**: everything under `/api/v1`, OpenAPI 3.1 at `/api/v1/openapi.json`, live Swagger UI at `/help/api`.

### Run it with a real model and forge

```bash
cp .env.example .env
# OPENAI_BASE_URL / OPENAI_API_KEY, FACTORY_MODEL / FACTORY_SMALL_MODEL / FACTORY_REVIEW_MODEL
docker compose up -d --build
bash scripts/forgejo-bootstrap.sh   # provisions the local forge and writes GITHUB_TOKEN to .env
```

Then open http://localhost:3000, pick a factory, and create a work item. `hello-nextjs` is lights-off.

### Known gaps

1. **Phase 6c**: external OIDC/IdP with group→org mappings (Keycloak/Authentik/Zitadel optional), remote runners,
   Temporal Cloud and multi-tenant credential isolation.
2. **Live GitHub path**: implemented and contract-tested, never exercised against a real repository (needs a PAT).
3. **Forge proxy mode**: SSH ships by default; the Caddy overlay is live-validated for session auth and HTTP, but
   a websocket upgrade has not been exercised end to end. The default single-origin setup proxies HTTP through the
   console.
4. **Replay scope**: a replay is a recording of *our* canonical events + patch, not an arbitrary harness
   tool-response trace.
5. **Promotion** merges the definition repo but does not rewrite the local checkout; `runs/canary/` GC is manual.

## Specs

13 living capabilities in `openspec/specs/`: factory-definition, run-lifecycle, harness-adapter, runner-protocol,
event-stream, web-console, factory-loop, measurement, benchmarks, self-improvement, code-forge, merge-queue,
automations.
