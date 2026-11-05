# Project status

Last updated: 2026-11-04

## Phase

**Phase 6a — secrets registry + per-agent MCP wiring: complete** (2026-10-30). The last two nav
stubs are real pages: a name-only secret registry with presence checks and a usage audit, and an MCP
registry with per-agent tool permissions and a runner-side connection test. Values never enter the
database, events, logs, API responses or definitions.

**Phase 6b — console auth/users + forge identity: complete** (2026-11-01). Real accounts and
sessions (argon2id hashes, opaque hashed tokens, HttpOnly cookie), an admin bootstrap, a real
Users page, admin/member roles, per-user work-item/run scope, and a forge proxy that asserts the
signed-in username. Compose runs with `AUTH_REQUIRED=1` and a documented local-development admin.

**Factory identity + complete purge — complete** (2026-11-02). Factories now have a committed
`fac_<ulid>` id, an owner-scoped path (`factories/<owner>/<name>`; legacy top-level directories are
admin-owned), and nested URLs (`/factories/<id>/…`, work items and runs nested under the factory).
The API is nested-only under `/api/v1/factories/:factoryId/…`; members see only their factories and
unauthorized IDs return 404. The delete path is a verified hard purge: DB rows, Temporal schedules,
running workflows and run directories, with git history and forge repos kept.

Next: **Phase 6c** — external OIDC/IdP (group→org mappings), remote runners, Temporal Cloud and
multi-tenant isolation. Also pending: the live GitHub path. Roadmap items 1–11 are implemented:
validation contract + QA pyramid, agent readiness, outcome metrics, guard hooks, Factory Stack,
trace-driven self-improvement, classifier routing + spend caps, work intake, progressive context,
governance/autonomy levels and the surface-agnostic CLI. The remaining roadmap item is long-running
missions (item 12) in `research/software-factory-ideas.md`.

**Next implementation workstream — remote runners + host observability (planned, not started).**
The plan is `docs/REMOTE_RUNNERS_PLAN.md`. The implementation branch will be `feat/remote-runners`;
no branch or code has been created yet. Planned OpenSpec changes: `add-remote-runners` (Linux agent,
enrollment, outbound mTLS, central scheduling, UI add-host) then `add-runner-observability`
(CPU/RAM/disk metrics, charts, alerts). Central Temporal remains the durable scheduler; remote hosts
get **no Temporal or Postgres access**. Linux comes first, then Windows native/Windows containers,
then macOS native/Tart. Alerts cover CPU, RAM, disk/inodes, heartbeat loss and lease queue wait, with
console inbox + webhook delivery.

### Readiness and public-release prep (2026-11-01)

**End-to-end lights-off readiness: PASS.** A new `hello-nextjs` factory (six agents, every gate `agent`,
`mergePolicy: auto_on_green`, autonomy enabled with an audited override) took work item
`wi_01M6B5097TGHK0KKZQN9BB3C4G` from `triage` to `done` with zero human decisions: six automatic gates, PR #1
merged, and a patch containing `site/package.json`, `site/app/layout.tsx`, `site/app/page.tsx`,
`site/next.config.ts`, `site/README.md` with `<h1>Hello, world!</h1>`.

Fixes that the test forced (all committed):

- **Prompt delivery** — the harness prompt was never sent; the stream then idled and reset. The prompt is now sent
  once per fresh session, after the stream consumer starts.
- **Factory agent identity** — `agent: "triage"` was passed to opencode, which has no such agent. Factory agent
  instructions are now injected into the prompt instead.
- **Patch capture** — `git diff` ignored untracked files, so implement shipped an empty patch. The runner stages
  `git add -A` and diffs against the recorded base; downstream stages apply the implement patch to their checkouts.
- **Work-item retry** — escalated/failed/blocked/cancelled items retry under a fresh attempt workflow id; a
  terminal run no longer shows a dead Cancel button; stage runs link to the item's retry.
- **Local forge** — Forgejo runs by default at `/extras/forgejo`, proxied by the console with single-user header
  auth; PR links now resolve. The forge client speaks Gitea's dialect against it.
- **Console ops** — auto-refresh (15s default, off on help), an operational dashboard (state, work, runs,
  deliverables), a persisted factory selection that survives top-level navigation, and a work-items board that
  hides cancelled items by default with status chips and timestamps.

Latest tags: `harden-runtime`, `secrets-mcp`, `api-v1-help`, `help-center`, `live-api-explorer`,
`api-explorer-parity`, `fix-ui-audit`, `fix-run-failures`, `run-actions`, `readiness-hello-nextjs`, `console-ops`,
`forgejo`, `agent-verdicts`, `console-auth`, `harden-runners`, `forge-ssh-public`, `readiness-qa`,
`factory-identity`, `factory-purge`, `readiness-identity`, `unify-factory-api`, `fix-forge-pr-files`,
`readiness-forge-files`, `graphite-command`, `add-run-retry`, `train-game-factory`, `train-game-run`,
`factory-engineering-foundation`. `bun run ci` 618 pass (168 integration tests skipped without compose);
smoke passes; Playwright 61; UI audit clean.

### Train game lights-off factory (2026-11-03)

Added `factories/admin/train-game` (`fac_01M6J3A931Y4JFBRAPVY9FYSNM`), a fully autonomous factory for a
React + Three.js browser game:

- Stages: triage → spec → implement → review (two independent reviewers) → verify (Playwright QA) → ship.
- Every gate is `agent`; `mergePolicy: auto_on_green`; `agentVerdict: required`.
- QA builds the app and runs Playwright against the production preview; review runs a two-reviewer committee.
- Lights-off run `wi_01M6J3HS2V0BR9QAGHA399FAYD` shipped **PR #1** in `acme/train-game` with zero human
  decisions. QA reported **6/6 Playwright checks passed** (canvas, HUD, throttle, teleport + Space delivery,
  three-delivery win, reset, clean console) in Chromium 156.0.8078.4.
- The PR and `main` contain the actual `train-game/` source (React, Three.js, Vite, TypeScript), not a patch
  artifact.
- The first triage attempt failed because Docker could not resolve `ai-utility`; the work item was retried after
  pointing API/worker at the reachable Tailscale IP, then completed on attempt 2.

### Factory engineering foundation (implemented 2026-11-03)

Research review of five AI-conference talks (Boundary, Eric Tech, Zach Lloyd, Tereza Tížková, Eno Reyes)
produced the roadmap in `research/software-factory-ideas.md`. The first sprint is implemented on
`feat/factory-engineering-foundation`:

1. **Validation contract + QA pyramid** — a persisted contract with unit/component/integration/e2e/manual
   checks; QA evidence and forge checks project to pass/fail/missing; enforced verify gates refuse approval
   with `validation_incomplete`. The train-game factory opts in with explicit build/e2e/acceptance checks.
2. **Agent readiness** — deterministic repository + factory score (0–100, ready/warn/not_ready), evidence
   and remediation per check; advisory by default, `readiness.enforceAutonomy` can block autonomy with an
   explicit override path.
3. **Outcome metrics** — human interactions per PR, autonomy ratio, cost per accepted change,
   signal-to-production cycle time, incident MTT and merged-code age, all additive to the existing keys.
4. **Deterministic guard hooks** — pure, fail-closed checks before a PR commit: protected branch, path
   containment, narrow secret patterns, changed-file/patch-byte/binary limits; `guard.checked` /
   `guard.failed` events and `GET /guard-hooks`.
5. **Factory Stack help page** — `concepts/factory-stack` explains the 00–06 layers and links the
   dashboard, readiness and definitions help.

Next candidates: trace-driven self-improvement, classifier-based model routing + spend caps, work intake from
Sentry/PostHog/Slack/Linear, progressive context/MCP discovery, governance/autonomy levels, surface-agnostic
agent, and long-running missions. Phase 6c infrastructure work remains blocked on external IdP/infra decisions.

### Read-path performance (implemented 2026-11-04)

`/chat` and `/inbox` were reported at 4s+. The baseline showed `/inbox` ~7s, `/work-items`
~3.5–4s and `/chat` 0.5–0.9s, with SQL plans at 0.1–1ms. The cost was repeated full registry
syncs (~253ms, ~194ms per `resolveFactory`), N+1 detail reads (~112 API calls for `/inbox`,
43 for `/work-items`) and synchronous git blocking the API event loop.

Implemented the grounded plan in `docs/PERFORMANCE.md`:

- `factories` registry read model (migration 018) + TTL/single-flight sync; `/factories` and
  `resolveFactory` are one indexed query (~2ms and ~1ms warm).
- Async git versioning (`createVersionAsync`, `git diff-index`) and commit-keyed definition cache.
- Batch `GET /api/v1/inbox` and `view=board` work-item projection; inbox/board pages make one
  API call each, with cursor pagination.
- React `cache()` for layout/page factory reads; session `last_seen_at` throttled to five minutes.
- Read-path indexes (migration 019) and honest `loading.tsx` skeletons.

Measured after (same data): `/inbox` 0.019–0.023s, `/work-items` 0.016s, `/chat` 0.008s,
`/dashboard` 0.105–0.152s; `/factories` 0.002s warm. `bun run ci` 620 pass / 172 integration
skipped; Playwright 61/61; inbox and auth-scope integration suites pass. `bun run perf:read-path`
re-measures the SLOs over warm rounds.

### Runner container leak fix and reaper (2026-11-04)

Docker Desktop had 29 `factory-runner-factory-run_*` containers. All 29 mapped to runs still
marked `running`; 5 workflows were `CANCELED` and 24 were no longer visible to Temporal; none
had `kill-runner` or finish-run steps.

Root cause: `RunWorkflow` awaited `readTerminalState` outside its `CancellationScope.nonCancellable`,
so cancellation after `collectArtifacts` skipped `finishRunActivity` and `killRunner`.

Fixed:

- one non-cancellable cleanup scope covering terminal event, artifacts, terminal-state read,
  finish, proxy revocation and `killRunner` (kill last, best-effort);
- `leaseRunner` heartbeats and kills the deterministic container name on cancellation;
- `killRunner` cleans up by deterministic name even without a lease handle;
- label-based reaper in the worker + `bun run reap:runners` (dry-run default, `--apply`);
- Temporal `shutdownGraceTime`/`shutdownForceTime` and compose `stop_grace_period: 150s`.

One-time cleanup: dry-run found 29 would-remove, 0 errors; `--apply` removed all 29 containers
and marked their runs `error` with `runner_orphaned: workflow_closed|workflow_missing`. Worker/API
rebuilt; the worker reaper starts cleanly and sees zero managed containers. `bun run typecheck`
and `bun test` (628 pass / 172 integration skipped) pass. See ADR-044.

### Roadmap items 6–11 (implemented 2026-11-04)

All six remaining roadmap items were implemented as separate OpenSpec changes and verified
with a full hello-nextjs delete → recreate → lights-off run between each item.

- **Trace-driven self-improvement** (`add-trace-driven-self-improvement`): deterministic trace
  evidence from the event log + review verdict; `redundant_tests`, `verbosity`, `scope`,
  `review_usefulness` checks; trace metrics on run detail; a trace scorer in hello-nextjs feeds
  the existing proposal path. Cycle PR #3.
- **Classifier routing + spend caps** (`add-model-routing-and-spend-caps`): opt-in
  `routing.classifier` cheap/standard/deep tiers, deterministic prompt/stage classifier,
  runtime routing consumption, `budget` caps per run/stage/factory, `budget_exhausted` in the
  pump, factory cap refusal and `GET /budget`. Cycle PR #4.
- **Work intake from anywhere** (`add-work-intake`): generic/Sentry/PostHog/Slack/Linear/Jira
  intake endpoints, provider HMAC verification, delivery dedupe, untrusted framing, new source
  values (migration 020) and intake audit. Cycle created via generic intake; PR #5.
- **Progressive context / MCP discovery** (`add-progressive-context`): `mcp.discovery`,
  deterministic capability selection, explicit deny globs, `mcp_tools` index (migration 021),
  discover/promote APIs and schema-size savings. Cycle PR #6.
- **Governance and autonomy levels** (`add-governance-autonomy-levels`): optional `governance`
  block, autonomy levels, model allowlists, deny/human-required actions, `policy` run steps,
  governance/audit APIs. SSO/OIDC remains a Phase 6c decision. Cycle PR #7.
- **Surface-agnostic agent** (`add-surface-agnostic-agent`): `factory run` and `factory intake`
  CLI commands using the same chat/intake API paths; Slack/CI reuse the intake contract. Cycle
  PR #8.

Factory issues found and fixed during the cycles:

- Re-running the same task produced a patch already on the forge branch; `applyPatch` now
  treats already-applied new-file patches as a no-op and commits an audit marker, and
  `FactoryWorkflow` escalates the item when a PR cannot be opened.
- Cancellation before the lease handle was returned skipped `killRunner`; the workflow now
  always attempts the deterministic-name kill, and a cancellation smoke confirms `kill-runner`
  runs and no container remains.
- Explicit `harness: fake` was overridden by routing; explicit harness now wins, preserving the
  smoke/e2e fake path.
- Cancellation preserved the operator's reason instead of the generic `stage run cancelled`.
- The dashboard now prefers the newest captured patch over a newer chat event-log artifact.

Verification: `bun run ci` 655 pass / 172 integration skipped / 0 fail; `bash scripts/smoke.sh`
SMOKE PASSED; full Playwright 61/61; `openspec validate --all` 35 passed. Local migrations 020
and 021 applied.

### Graphite Command shell (2026-11-03)

The left menu and header now follow the selected **Graphite Command** direction:

- Dark graphite sidebar (`slate-950`), teal active state, icon + label rows, grouped Workspace / Factories
  sections, and a dark factory switcher.
- The rail starts expanded and collapses to an 80px icon strip via the header toggle; collapsed labels stay
  available as tooltips and screen-reader text.
- The nav area scrolls on short viewports but has no visible scrollbar; API and Help are part of the main
  menu, not a separate footer block. The unclear “Usage available” placeholder was removed.
- Dark sticky header with a breadcrumb (`Software Factory / <page>`), auto-refresh, and **Help** at the top
  right. There is no top-right avatar; the account block stays in the sidebar footer.
- Account footer keeps the role badge, sign-out, and the GitHub repository icon.
- A local `NavIcon` component supplies the navigation icons without adding an icon package.
- Option 02 was selected; the temporary visual review page was removed after the choice.

### Unified factory paths (2026-11-02)

Every factory-scoped API and browser resource is now addressed through the factory id. The remaining global
scoring group moved under `/api/v1/factories/:factoryId/...`:

- scores, score detail, calibration, scoring, benchmark-run detail, improvement-run detail, proposals
  (+ decision/apply), lessons (+ promote), and webhook deliveries.
- No factory-scoped request uses `?factory=` or `?factoryId=`; the path supplies the factory.
- Work-item/run creation takes the factory from the path; no `factoryId` in the body.
- Browser score detail and MCPs moved to `/factories/<id>/scores/<id>` and `/factories/<id>/mcps`.
- Global: `/factories`, `/inbox` (cross-factory queue), `/chat`, `/secrets`, `/users`, `/help`.
- No DB migration; the identity/registry schema is unchanged.
- Breaking `/api/v1` rewrite; ADR-039 records the exception. `bun run ci` 735, smoke passes, Playwright 56,
  UI audit clean.

### Forge PR content fix (2026-11-02)

Previous readiness PRs contained only `changes/<workItemId>.patch` (the diff text) plus the seeded README/probe
files — no `site/app/layout.tsx`, `site/app/page.tsx` or other web code. Root cause: `forgeOpenPullRequest`
committed a hard-coded patch artifact instead of applying the implement patch; QA passed because it tested the
runner workspace, not the forge branch.

Fixed:

- `forgeOpenPullRequest` now checks out the new branch, applies `patch.diff` to a temp copy of the base snapshot
  with `git apply`, and commits the resulting files (add/modify/delete). Missing/empty patches fail with
  `patch_missing`; unapplicable patches with `patch_apply_failed`; binary patches are rejected.
- The Forgejo repo was deleted and recreated clean; the bootstrap now resolves the factory id and posts the
  integration to `/api/v1/factories/:id/integrations/github` (it was still using the old global path).
- Fresh lights-off run `wi_01M6ED4H1FDRQFHJ29R5MGS5TG` merged **PR #1** with zero human decisions. The PR and
  `main` now contain `site/package.json`, `site/app/layout.tsx`, `site/app/page.tsx`, `site/next.config.ts`,
  `site/tsconfig.json` and `site/README.md`; QA ran Playwright/Chromium and reported `1 passed (635ms)`.

### Factory identity + purge v2 (2026-11-02)

- **Identity:** `factory.yaml` carries `id: fac_<ulid>`; a `factories` registry maps id → owner/name/key/path.
  New factories live at `factories/<owner>/<name>`; legacy top-level directories stay admin-owned. The internal
  `factory` key is `owner/name` (or the legacy name), so two users can both own `hello-nextjs`.
- **URLs/API:** nested-only — `/factories/<id>/dashboard`, `/factories/<id>/work-items/<id>`,
  `/factories/<id>/runs/<id>` and `/api/v1/factories/:factoryId/…`. The old name/global routes are removed
  (breaking `/api/v1`; ADR-038 records the exception to the prefix-bump rule).
- **Ownership:** members list/resolve only their factories; admins see all; cross-user IDs return 404. Playwright
  covers the member-vs-admin isolation path.
- **Purge v2:** `DELETE /api/v1/factories/:factoryId` is fail-closed, refuses active work unless forced, deletes
  DB rows in one verified transaction, deletes Temporal schedules, terminates running workflows and removes
  `runs/<id>/`; git history and the forge repo/PRs remain. The CLI logs in, resolves the ID and calls it.
- **One-off cleanup:** stale `hello-nextjs` rows from before the recreation were purged (4 work items, 25 runs,
  25 run dirs), keeping the PR #4 readiness rows.
- **Fresh readiness run:** work item `wi_01M6DF5HG9EMWWPKN4JB4YGCDG` ran through the new ID URL with zero human
  decisions and merged **PR #5**; QA ran Playwright 1.64.1/Chromium and reported `1 passed (687ms)`.

### Second lights-off run with Playwright QA (2026-11-02)

The deleted `hello-nextjs` factory was recreated with a dedicated **QA agent** (role `verify`) that builds the
generated site, starts it on port 3100 and runs a real Playwright browser test (`@playwright/test@1.64.1`,
Chromium 156) asserting the exact `<h1>Hello, world!</h1>`. The runner image now bakes Playwright + Chromium so
the verify stage does not download a browser per run.

Work item `wi_01M6D66NASJ95RN86JVTZKTBF0` (attempt 2) went `triage → spec → implement → review (2 reviewers) →
verify → ship` with **zero human decisions** and merged **PR #4**:
`http://localhost:3000/extras/forgejo/acme/hello-nextjs/pulls/4`. The patch contains
`site/package.json`, `site/app/layout.tsx`, `site/app/page.tsx`, `site/next.config.ts`, `site/tsconfig.json` and
`site/README.md`; the QA verdict records a passing Playwright run (`1 passed (543ms)`).

The first attempt escalated at triage because the opencode adapter emitted `run.completed` without the final
assistant text, so the required verdict parser saw nothing. Fixed: the adapter now carries the last assistant
message as the run summary (unit + contract tests updated), which is what the structured verdict channel reads.

### Agent verdicts, auth and runner hardening (2026-11-01)

- **Agent verdicts:** agent-gated stages are prompted to end with a fenced JSON verdict
  (`approve | request_changes | reject`); the parser accepts structured and explicit textual signals
  (`VERDICT: FAIL`), the factory-level `agentVerdict: advisory | required` decides what a missing verdict means,
  and `gate_decisions.verdict` stores the decision + source for audit. `hello-nextjs` is `required`.
- **Console auth:** `users` + `sessions` (migration 016), argon2id hashes, opaque session tokens hashed at rest,
  `AUTH_REQUIRED=1` in compose, bootstrap admin from env, `/login`, real Users page (create, role, disable and
  delete with self/last-admin guards), admin/member roles, per-user work-item/run scope, and cookie forwarding
  through the console proxy. The Forgejo proxy asserts the signed-in username; each user gets a best-effort
  personal org `u-<username>`.
- **Runner hardening:** bubblewrap (`bwrap`) sandbox for Linux with read-only root, writable workspace and
  optional network unshare; a requested-but-missing sandbox fails with `runner.sandbox_unavailable`. Recorded
  replay (`replayFrom: run_…`) re-emits a run's events and applies its patch for model-free benchmark trials.
  Hydration mismatches are gone: `TimeAgo` renders a deterministic value first, and the UI audit no longer
  tolerates React #418.

What is left:

1. **Phase 6c** — external OIDC/IdP and group→org mappings (Keycloak/Authentik/Zitadel), remote runners,
   Temporal Cloud, multi-tenant credential isolation.
2. **Live GitHub path** — implemented and contract-tested, not exercised against a real repository (needs a PAT).
3. **Forge proxy mode** — SSH ships on the default stack; the Caddy mode is live-validated for session auth and
   HTTP reverse-proxying (on a test port), but a websocket upgrade has not been exercised end to end.
4. **Benchmark replay scope** — replays our canonical events + patch, not arbitrary harness tool-response traces.

### Forge transport + public polish (polish-forge-and-public, 2026-11-01)

The forge was HTTP-only behind the console proxy: no `git push` over SSH, no websocket
upgrades, and the public repo had no issue/PR templates or a screenshot. All three are fixed
without changing the default single-origin setup (ADR-034).

- **SSH (default stack).** `forgejo` publishes `2222:22`; `DISABLE_SSH=false`,
  `START_SSH_SERVER=true`, `SSH_PORT=2222`, `SSH_LISTEN_PORT=22`, `SSH_DOMAIN=localhost`, so
  clone URLs are `ssh://git@localhost:2222/<org>/<repo>.git` and host keys persist under
  `/data/gitea/ssh` in `forgejo-data`. The image's OpenSSH s6 service also binds `:22`, so it is
  masked with `tmpfs: /etc/s6/openssh` — otherwise the container exits with
  `bind: address already in use`. No key is seeded; add one in Forgejo → Settings → SSH keys.
- **Optional websocket mode.** `compose.proxy.yaml` + `Caddyfile` add Caddy on `:3001`, set the
  forge `ROOT_URL=http://localhost:3001/` with an empty `STATIC_URL_PREFIX`, and reverse-proxy
  everything (upgrades included). Identity stays asserted: `GET /api/v1/auth/forge-identity`
  answers `200` + `X-WebAuth-User` for a session (`401` otherwise; the auth-off fallback is
  `FORGEJO_ADMIN_USER`), and Caddy's `forward_auth` copies the header onto the proxied request.
  The console stays on `:3000`; `docker compose up -d` alone is unchanged.
- **Bootstrap.** `scripts/forgejo-bootstrap.sh` signs in once as the bootstrap admin before
  talking to the forge (the console proxy redirects every request without a session, token or
  not), and prints both HTTP and SSH clone URLs.
- **Public repo.** `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml` and
  `.github/PULL_REQUEST_TEMPLATE.md`; a real console screenshot at `docs/assets/console-dashboard.png`
  embedded in `README.md`; a CI badge for `kutovoy/ai-software-factory` next to the
  license/stack badges. Creator/attribution section untouched.
- **Docs/help.** README (SSH clone, proxy mode, services table), `docs/HANDOVER.md` (transport
  commands, known gaps) and the `forgejo` help entry now describe SSH and the proxy mode.

Verification: `bun run ci` → pass; `openspec validate polish-forge-and-public` → valid;
`docker compose config` and `docker compose -f compose.yaml -f compose.proxy.yaml config` →
valid; `caddy validate` on the Caddyfile → valid; `ssh -p 2222 git@localhost` → reaches the
built-in server (`SSH-2.0-Go`), `Permission denied (publickey)` without a key as expected;
`GET /api/v1/auth/forge-identity` → `200` + `X-WebAuth-User: admin` with a session and `401`
without; `bash scripts/smoke.sh` → `SMOKE PASSED`; the screenshot is a real dashboard at
1440×900 with data (25 runs, 4 done work items).

### Local forge: Forgejo served by the console (add-forgejo, 2026-11-01)

Every factory PR was recorded against the fake backend, so links pointed at
`https://forge.local/...` and resolved nowhere. The stack now owns its forge and serves it from
the console origin (ADR-032).

- **Compose.** A pinned `codeberg.org/forgejo/forgejo:17.0.1` service with its own database
  (`forgejo`, created by `scripts/postgres-init.sql`; an existing volume needs one manual
  `create database forgejo owner factory`), a `forgejo-data` volume and a `/api/healthz`
  healthcheck. No host port: the forge is reachable only from the compose network, so the
  identity header cannot be spoofed from a browser. Enabled by default; opting out is
  `FORGEJO_ENABLED=0 docker compose -f compose.yaml -f compose.no-forgejo.yaml up -d` (the
  overlay assigns a profile, so Compose skips the service).
- **Subpath hosting.** `ROOT_URL=http://localhost:3000/extras/forgejo/`,
  `STATIC_URL_PREFIX=/extras/forgejo`; every generated link and asset already carries the
  prefix. The console serves it from `apps/web/src/app/extras/forgejo/[[...path]]/route.ts`,
  a streaming catch-all proxy that strips the prefix and injects `X-WebAuth-User` — a
  `next.config` rewrite cannot add a request header, which is why this is a route handler and
  not a rewrite. `skipTrailingSlashRedirect` plus a prefix-scoped middleware keep the
  trailing-slash home page (`/extras/forgejo/`) a 200 instead of Next's 308.
- **Single-user auto-login.** Forgejo runs `ENABLE_REVERSE_PROXY_AUTHENTICATION` with
  `REVERSE_PROXY_AUTHENTICATION_USER=X-WebAuth-User`; opening the forge lands on the seeded
  admin's dashboard with no password prompt. Settings states the mode and names the
  multi-user path (Phase 6 console auth asserts the signed-in user; Forgejo OIDC group
  mappings place each user in their own organization/team; Keycloak optional). Help's
  "Where results live" says the same.
- **Bootstrap.** `scripts/forgejo-bootstrap.sh` waits for health, ensures the admin (password
  generated once into `.env`), reuses a token that still resolves or generates one
  (`--raw`, captured, never printed), creates the `acme` organization and the
  `hello-nextjs` repository with an initial commit, registers `GITHUB_TOKEN` as a secret
  *name*, records the factory's forge integration and restarts api+worker. A second run
  changes nothing.
- **Forge backend.** The `CodeForge` GitHub client detects the Gitea dialect from
  `GITHUB_API_BASE_URL` and adapts behind the same contract: refs from `git/refs`, branches
  via `POST /branches`, commits through the contents API (Gitea's blob/tree/commit writes are
  read-only), checks from commit statuses (an empty status set is green — a forge with no CI
  has nothing red), merges via `POST .../merge` with `Do`, and revert by restoring the target
  tree file by file. Which backend a factory uses is decided by its stored integration
  (enabled + not dry-run + a secret that resolves ⇒ real forge), so smoke and CI stay on the
  fake backend and credential-free.
- **Git over HTTP** works through the console:
  `git clone http://localhost:3000/extras/forgejo/acme/hello-nextjs.git`. SSH (published on
  `localhost:2222`) and an opt-in websocket proxy (`compose.proxy.yaml`) were added later —
  see "Forge transport" below.

Verification (2026-11-01): `docker compose up -d --build` → forgejo healthy;
`GET /extras/forgejo/` → 200 (auto-login as `factory`, assets and redirects on the console
origin); `git clone http://localhost:3000/extras/forgejo/acme/hello-nextjs.git` → ok;
`bash scripts/forgejo-bootstrap.sh` twice → the second run reuses the token and changes
nothing (no value printed); a live Gitea-dialect check against the real instance (checkout,
branch, commit, PR idempotency, checks, comment, merge, revert, `protected_branch`/`not_found`
/`invalid_state`) → passed; a real lights-off run on `hello-nextjs` (opencode + `best_llm`,
all gates agent, override autonomy) → item `wi_01M6C2WA3J8V6JYWFA97SXMEMX` `done` at `ship`,
PR #3 merged (`c44db4f…` is now `main`), `http://localhost:3000/extras/forgejo/acme/hello-nextjs/pulls/3`
→ 200 and rendered on the item and the dashboard; `bun run ci` → 516 pass / 0 fail;
`bash scripts/smoke.sh` → `SMOKE PASSED` (forgejo health + assets + 1 recorded PR link
resolving through the console); `bunx playwright test` → 50 passed; `UI_AUDIT=1 bunx
playwright test audit-deep.spec.ts` → 36 routes, 0 problems; `openspec validate add-forgejo`
→ valid. The token appears in no run directory, event or container log (checked by grep).

Deferred: multi-user identity (Phase 6 + OIDC group mappings); a dedicated proxy if pushes
ever outgrow the console handler; Forgejo Actions/CI (checks are commit statuses, and an empty
status set is green).

### Console operations: auto-refresh, operational dashboard, stable selection, board filters (improve-console-ops, 2026-11-01)

The console was a set of projections you had to reload by hand, a dashboard that reported
metrics but not what the factory produced, a sidebar that reset the selected factory whenever a
top-level item was clicked, and a board drowning in cancelled items.

- **Auto-refresh.** `AutoRefresh` in the shared header (right of `?`): Off / 15s / 30s / 60s,
  default 15s, persisted in `localStorage`. It calls `router.refresh()` (server components read
  the API with `cache: 'no-store'`, so this re-runs the projection), skips ticks while
  `document.hidden`, refreshes once on becoming visible, and shows "updated <relative>". On
  `/help` and `/help/*` the control renders nothing and no timer starts.
- **Dashboard as an operations view.** State card (autonomy enabled/paused + declaration and
  override, canary active/last, last activity across runs and items), work items (status counts
  + newest items with stage/status/updated links), recent runs (status, harness/model, cost,
  started, link), deliverables (deduped PR links, `done`/merged count, the latest patch from the
  newest runs that captured artifacts, plus the "results live in the PR and the run's artifacts"
  explainer). Metric cards and cost-by-stage are unchanged; each new section has an honest empty
  state.
- **Stable factory selection.** The root layout reads the `factory` cookie and passes it to the
  sidebar; `/factories/:name/*` wins, otherwise the persisted factory holds, and the switcher
  writes the cookie and navigates to that factory's dashboard. Client state starts `null` so the
  server and client markup agree.
- **Work-items board.** Status chips (all / active / escalated / done / failed / cancelled) with
  cancelled hidden by default; cards show created and last-updated relative times with the
  absolute timestamp in `title`; the factory filter is unchanged and an empty filter result says
  so instead of claiming there is no work.

Verification (2026-11-01): `bun run ci` → 512 pass / 0 fail; `bash scripts/smoke.sh` →
`SMOKE PASSED`; `bunx playwright test` → 49 passed (4 new in `e2e/console-ops.spec.ts`);
`UI_AUDIT=1 bunx playwright test audit-deep.spec.ts` → 36 routes, 0 problems. No backend change:
the existing `/runs`, `/work-items`, `/autonomy`, `/factories/:name/canary` and `/runs/:id`
projections already carry every field the dashboard needs.

Deferred: nothing from the change; the dashboard inspects the three newest runs for artifact
metadata (the summary projection has no artifacts field, and adding one would be a backend
change).

### Lights-off readiness: stage hand-off + complete patch capture (2026-11-01)

A real-model lights-off run (`hello-nextjs`, all gates `agent`, `mergePolicy: auto_on_green`,
`best_llm` via opencode on `local-docker`) exposed two loop defects:

1. **Patch capture dropped new files.** `git diff --binary` returns nothing for untracked files,
   so an implement agent that creates a fresh `site/` tree produced an empty `patch.diff`; the
   forge committed an empty patch and the PR carried no change. `gitDiff` now stages everything
   (`git add -A`) and diffs the working tree against `HEAD`, covering new, modified and already
   staged files (both the local runner and the docker artifact collection).
2. **Downstream stages ran on a clean tree.** Every stage cloned the definition commit, so review
   and verify inspected a workspace without the implement change: verify correctly reported FAIL
   and the agent gate approved anyway. `RunInput.patchRunId` carries the implement run id; the
   runner applies `runs/<implementRunId>/patch.diff` to the fresh checkout before the sandbox
   starts (`RepoSpec.patch`), so review/verify see the change. Implement always starts clean, so
   its patch stays a diff against the definition commit. The id survives `continueAsNew`.

Also fixed: `ship` is a forge/merge stage, not an agent run (the graph compiler already documents
that). It now runs the `gate` phase only instead of spawning a redundant agent run with the raw
work-item prompt (that run used to re-implement the task in a throwaway workspace).

Verification (2026-11-01): `bun run ci` → 512 pass / 0 fail (6 new runner tests in
`packages/runners/test/patch.test.ts`); work item `wi_01M6B5097TGHK0KKZQN9BB3C4G` ran
triage → spec → implement → review (2 reviewers) → verify → ship to `done` with no human gate
decisions (all six gates `automatic: true`), a merged fake-forge PR #1 (`merged: true` in the
workflow result), and a 2241-byte patch containing `site/package.json`, `site/app/layout.tsx`,
`site/app/page.tsx`, `site/next.config.ts`, `site/README.md` with `<h1>Hello, world!</h1>`.
Review and verify both saw the applied patch and returned PASS. The first attempt
(`wi_01M6B2Q33WN3YG4KE50NDA9E8G`) exposed the empty-patch bug: it reached `done` with a 0-byte
patch and a verify run that reported FAIL against a clean tree.

Deferred: an agent gate still resolves `approve` whenever the stage run ends `ok`; the agent's
textual verdict is advisory. A structured verdict channel (so a FAIL report can reject or
request changes without a human) is a follow-up design change.

### Run actions: contextual cancel + work-item retry (fix-run-actions, 2026-11-01)

A finished run no longer renders a dead "Cancel run" button, and an escalated item is no
longer a dead end. The run page renders `CancelRunButton` only for
`pending|running|cancelling`; a terminal run shows `Run ended · <status>` instead. Factory
stage runs (`kind === 'run'`) offer no per-run retry — `POST /runs/:id/retry` still refuses
them with `run_not_retryable` — and instead link to the owning work item
(`GET /runs/:id` now projects `workItemId`, derived from the documented
`run_<ulid>_<stage>_<n>` scheme). Chat runs keep "Retry as new run".

**Retry-as-new reconciled (2026-11-03).** The `add-run-retry` change is now verified against the
nested API: `POST /api/v1/factories/:factoryId/runs/:id/retry` starts a fresh chat run with
`retryOf`, the original reports `retriedBy`, and a 60s dedupe returns the existing child. API
integration tests cover eligible, refused (`running`/`ok`/stage), dedupe and original immutability;
Playwright covers cancelled-run retry and lineage.

**Retry mechanics.** `POST /api/v1/work-items/:id/retry` (`{actor, reason?}`) re-opens an
`escalated|failed|blocked|cancelled` item at its current stage: one locked transaction
transitions it to `active`, clears `cancel_requested_at/actor/reason` (the cancellation
stays in `work_item_events` as history) and appends exactly one `work_item.retried` event
carrying the previous status, actor, reason, attempt and the new workflow id. The current
stage is then dispatched under a new attempt workflow id, `factory-<itemId>-a<n>`: a closed
Temporal workflow cannot be started again under the old id. `attempt` is derived from the
retried-event count (1 = first dispatch) and exposed on the detail and list projections
along with `retriedAt` and the live `workflowId`; cancel/pause now target that id. The
per-stage attempt counters are reconstructed from `gate_decisions` and stage run ids, with
a floor of `attempt - 1` for the current stage, so every child `stage-<item>-<stage>-<n>`
and `run_<ulid>_<stage>_<n>` id is fresh. A double submit within 60 s returns the dispatch
the first call started (`deduped: true`, no second workflow); `active` and `done` are
refused with `work_item_not_retryable` naming the status. The retry input is rebuilt from
the item, its creation snapshot (prompt, harness/model/runner, merge-queue choice) and the
current definition graph, keeping the item's pinned `definitionCommit`. If the workflow
cannot start, the item is restored to the status it came from so it stays retryable.

**Console.** The work-item detail page shows an attempt badge and a "Retry work item"
control (actor + optional reason) for retryable statuses, disabled while in flight and
reloading from the read model on success; the Retries list renders every
`work_item.retried` audit row. Help entries for Runs and Work items describe the contextual
actions.

Verification (2026-11-01):

```
bun run ci                     → typecheck clean; 506 pass / 130 skip / 0 fail
work-items integration (PG + Temporal)
                               → 13 pass (9 existing + 4 new: escalated retry → active
                                 attempt 2 + factory-<id>-a2, double submit deduped with
                                 one retried event, active/done refused, cancelled item
                                 clears flags and keeps the cancellation in the audit)
docker compose up -d --build   → api, worker, web, postgres, temporal healthy
bash scripts/smoke.sh          → SMOKE PASSED incl. §17 retry (attempt 2, a2 workflow,
                                 flags cleared, cancellation kept, then cleaned up)
cd apps/web && bunx playwright test → 45 passed (43 existing + 2: terminal run has no
                                 cancel/retry-as-new for chat; escalated item retried
                                 from its page → active attempt 2 with a second dispatch)
UI_AUDIT=1 bunx playwright test audit-deep.spec.ts → 36 routes, 0 hard problems (three
                                 pages logged the tolerated React hydration #418 on a
                                 time-formatted page: no overflow, console errors or bad
                                 responses)
```

Caveats: `failed` is accepted by the retry guard for forward compatibility, but no writer
produces that status today (a failed stage run escalates). A retry recompiles the current
definition graph (the on-disk definition), while the item stays pinned to its original
commit; a stage removed from the graph refuses with `invalid_state`. The deduped response
does not re-read the Temporal run id (it is null); the workflow id is returned.

### Real-model runs: the docker path now works end to end (2026-10-31)

A chat run failed with `Activity task failed`. The stored error was Temporal's wrapper; the cause was
`RunnerError: docker_unavailable` — the worker image never installed the `docker` CLI, so `leaseRunner`
could not start a sandbox even though `/var/run/docker.sock` was mounted and usable.

**Worker image.** `packages/orchestration/Dockerfile` installs `docker-ce-cli` from Docker's Debian apt
repo (keyring + `deb [arch=$(dpkg --print-architecture)]` for the image's own `VERSION_CODENAME`; trixie
on arm64 here). No daemon. `docker compose exec worker docker version` prints client 29.9.2 against server
29.7.2, and `docker image inspect factory-runner:local` succeeds from inside the worker.

**Containerised worker.** Installing the CLI exposed several more defects that only appear when the worker
is itself a container:

- A sandbox port published on the host's `127.0.0.1` is not reachable from another container's loopback, and
  the docker daemon cannot see the worker's filesystem (a `-v` bind mount pointed at `/tmp/factory-run-*`
  inside the worker, so the sandbox got an empty `/workspace`). The docker backend now takes
  `network` + `workspaceMode`: compose sets `RUNNER_NETWORK=factory-runners` (a dedicated network holding
  only the worker and its sandboxes — never Postgres, Temporal or the API) and `RUNNER_WORKSPACE_MODE=copy`
  (`docker cp` in before start, back before artifacts). A host worker keeps the bind mount and the
  published port; the defaults are unchanged.
- opencode 2.2's `serve` **generates a random server password** and answers `401` without basic auth. The
  readiness probe sent no auth, so every lease waited 60 s and failed on a healthy sandbox — and the retry
  re-attached to the half-dead container, which is what produced the `ECONNRESET` mid-stream. The password
  is now derived per run (`harnessPasswordFor(runId)`, `FACTORY_HARNESS_SECRET` optional), injected into the
  harness command, and sent with the probe (`harness.headers`).
- opencode ignored `OPENAI_BASE_URL` and silently used its built-in default model (`gpt-6.1-terra`) against
  `api.openai.com`. The runner image now ships `/root/.config/opencode/opencode.json` declaring a `factory`
  provider templated from `{env:OPENAI_BASE_URL}` / `{env:OPENAI_API_KEY}`, and the adapter addresses a bare
  model name (`best_llm`) as `factory/best_llm` instead of leaving the model unset.
- opencode 2.2 renamed the bus events (`session.next.*` → `session.*`, tool call id `callID` → `id`) and ends
  an execution with `session.execution.succeeded|failed` rather than `session.idle`. The mapper translates
  both spellings, so a pinned fixture and the current image produce the same canonical events.
- `pumpEvents` only sent the prompt when `sessionRef` was empty, but `startHarness` always creates the
  session, so a real run streamed forever without ever prompting. The prompt is now sent once, marked by a
  durable `prompt` step that survives activity retries and worker restarts.

**Cause-preserving failures.** `describeFailure()` (`packages/orchestration/src/failures.ts`) walks the
`cause` chain, drops Temporal wrappers and duplicates, and prefixes the code, so a run records
`docker_unavailable: docker CLI/server is not available` instead of `Activity task failed`. Runner
activities rethrow `RunnerError` as an `ApplicationFailure` with `type = code` and the error shape in
`details` (retry behaviour unchanged), which is what keeps the code through Temporal's serialization; a
`permission_timeout` failure now carries that code too.

**Run page.** The meta grid shows a 12-character short SHA with the full 40-character value in `title` and a
copy button, every cell is `min-w-0`/truncating, and the steps/artifacts cards no longer blow the grid out at
narrow widths. A failure panel shows the message, the code (parsed from the `<code>: <message>` prefix, no
schema change), each failed step, the workflow id with a copy affordance and a link to
`http://localhost:8233/namespaces/default/workflows/<workflowId>`, plus a remediation hint for
`docker_unavailable`, `model_unresolved`, `runner_unavailable`, `permission_timeout` and a generic fallback.
A cancelled run shows its reason and actor; a healthy run renders no panel. The code prefix is parsed for
factory snake_case codes and Node's ALL-CAPS ones (`ECONNRESET`), and `describeFailure` does not repeat a code
that the message already carries.

Verification (2026-10-31):

```
docker compose exec worker docker version → client 29.9.2 / server 29.7.2 (socket usable)
bun run ci                     → typecheck clean; 503 pass / 126 skip / 0 fail
docker compose up -d --build   → api, worker, web, postgres, temporal healthy
bash scripts/smoke.sh          → SMOKE PASSED
cd apps/web && bunx playwright test → 42 passed (failure panel + Temporal link on the newest failed
                                 run, cancelled panel, meta cells non-overlapping at 1280/900/600px
                                 with no page overflow)
UI_AUDIT=1 bunx playwright test audit-deep.spec.ts → 36 routes, 0 with problems
real run run_mvxea0vq_d0f54acc → status ok, harness opencode, model best_llm, 19622 in / 719 out tokens,
                                 events: run.started, message.delta ×152, tool.call.started/completed ×9,
                                 message.completed, usage.updated ×12, run.completed
real run run_mvxdk5md_41eddbfb → status ok (first tool-using chat: read README.md, 10464 in / 91 out)
```

Caveats: the sandbox image fetches `@ai-sdk/openai-compatible` on first use, so a run needs outbound network;
`host.docker.internal` resolves automatically on Docker Desktop and still needs `extra_hosts` on Linux. Runs
created before this change keep the wrapper text in `error` — the panel shows it with the generic hint.

### Live API explorer with a same-origin proxy (2026-10-31)

`/help/api` is now executable. A client-only Swagger UI (`swagger-ui-react` 5.34.1, imported
with `dynamic(..., { ssr: false })`, stylesheet loaded once in the root layout) renders the
served OpenAPI document with "Try it out" enabled, deep links on, persisted auth and
`docExpansion: 'none'`. It has explicit loading, error (with retry) and render-failure states,
so a broken document never leaves an empty shell. A banner above it states that actions run
against this stack — including destructive POST/PUT/PATCH/DELETE calls — and that the local API
has no authentication. The existing server-rendered reference stays below as the no-JS fallback.

The document declares `http://localhost:8080` as its server, which a browser cannot call
cross-origin. Every explorer request is therefore rewritten to the console origin and forwarded
by a new catch-all handler, `apps/web/src/app/api/v1/[...path]/route.ts`: GET/POST/PUT/PATCH/
DELETE/HEAD/OPTIONS with query, body and headers, status/content-type/body returned unchanged,
the response body streamed (SSE stays incremental), and hop-by-hop headers (`host`,
`connection`, `content-length`, `transfer-encoding`, …) dropped in both directions. The
upstream is asked for an identity encoding because the runtime decodes compressed bodies.
This is the documented Swagger UI CORS workaround and keeps the browser on the console origin
(ADR-012); the backend prefix is applied server-side by `apiUrl` (ADR-030).

`swagger-ui-react` pulls `@swagger-api/apidom-parser-adapter-{json,yaml}`, whose native
`tree-sitter` builds ship prebuilds that need libstdc++ (absent from `oven/bun`), so Bun fell
back to `node-gyp rebuild` and the images failed without Python. Root `package.json` now sets
`"trustedDependencies": []`: dependency lifecycle scripts are blocked at install time. Nothing
in the repo needs one (checked: the only scripts are tree-sitter builds, `@scarf/scarf`
telemetry, `@swc/core`'s optional-binding probe, protobufjs's cosmetic postinstall and
core-js's donation banner), and the explorer uses Swagger UI's prebuilt browser bundle, not
the native parsers.

Verification (2026-10-31):

```
bun run ci                     → typecheck clean; 481 pass / 126 skip / 0 fail
docker compose up -d --build   → api, worker, web, postgres, temporal healthy
bash scripts/smoke.sh          → SMOKE PASSED
cd apps/web && bunx playwright test → 39 passed (38 existing + explorer: banner, operations
                                 render after expanding a tag, Try it out → Execute GET
                                 /api/v1/health → 200 on the console origin, proxy unknown
                                 path → backend 404 envelope, static fallback below)
UI_AUDIT=1 bunx playwright test audit-deep.spec.ts → 36 routes, /help/api clean
                                 (0 overflow, 0 console errors, 0 bad responses)
curl localhost:3000/api/v1/health → 200
```

Caveats: the explorer now shows the console origin (`/`) in its Servers dropdown, because it
loads the `?servers=console` variant of the document; the raw document still advertises
`http://localhost:8080` for Postman and other Swagger UI imports. Try-it-out can mutate the
local stack; auth is still not modelled (Phase 6b).

### API explorer presentation parity (2026-10-31)

`/help/api` now uses the content width instead of a 4xl column (prose and callouts keep their
`max-w-prose` reading measure) and enables what the classic Swagger UI page has: filter box,
`tagsSorter: 'alpha'`, `operationsSorter: 'alpha'`, request durations, extensions and common
extensions, `docExpansion: 'list'`, `defaultModelsExpandDepth: -1`, deep links, try-it-out and
persisted authorization. A toolbar above the explorer carries the API version, the
console-proxied base URL (`/api/v1`) and the no-auth warning — the part of Swagger UI's
Standalone topbar that matters here.

`apps/api/openapi.json` gained a description for each of its 18 tags and an `info.description`
that states the versioning rule, both base URLs (direct and console-proxied) and the missing
authentication. The console spec proxy (`apps/web/src/app/api/openapi.json/route.ts`) accepts
`?servers=console` and rewrites `servers` to
`[{url: '/', description: 'Console origin (same-origin proxy)'}]`, so the Servers dropdown names
the origin requests actually use; the default response stays byte-identical to the served
document (direct API server) for Postman/Swagger UI imports. The upstream fetch is cached
in-process for 30s. The explorer loads the console-targeted document; the request interceptor
stays as a safety net for a stale cached document.

Verification (2026-10-31):

```
bun run ci                        → typecheck clean; 481 pass / 126 skip / 0 fail
docker compose up -d --build      → api, worker, web, postgres, temporal healthy
bash scripts/smoke.sh             → SMOKE PASSED (65 ok)
cd apps/web && bunx playwright test → 40 passed (help: toolbar, filter narrows tags, tag
                                    descriptions, Servers = console origin, Execute GET
                                    /api/v1/health → 200 + Request duration, raw document keeps
                                    http://localhost:8080)
UI_AUDIT=1 bunx playwright test audit-deep.spec.ts → 36 routes, 0 with problems
                                    (/help/api: overflowX 0, 0 console errors, 0 bad responses)
curl localhost:8080/api/v1/openapi.json → servers [{"url":"http://localhost:8080",…}]
curl localhost:3000/api/openapi.json?servers=console → servers [{"url":"/",…}]
```

### Versioned API, in-product reference, supported projects, pinned sidebar (ADR-030, 2026-10-31)

The HTTP surface is now path-versioned and documented inside the product. Every public
resource lives under `/api/v1` via one prefix constant; `GET /health` stays unversioned for
probes and `GET /api/v1/health` serves the same check to versioned clients. Unversioned
resource paths return 404 (asserted). `apps/api/openapi.json` is an OpenAPI 3.1 document with
61 paths (method, path, summary, parameters, response codes), served at
`GET /api/v1/openapi.json`; a contract test compares the registered route table with the
document and fails in either direction naming method + path, so the document cannot drift.
Every caller was moved in the same change: the console's server fetches (`apiUrl`/`apiGet`),
same-origin route handlers, smoke scripts and docs. Webhook URLs render
`/api/v1/webhooks/:provider`.

The console gained a sidebar `API` entry (`nav-api`) above `Help`, and `/help/api` renders the
endpoint reference from the served document — grouped by resource, with method badge, path,
summary, parameters and response codes — plus a link to the raw document and the versioning
rule (breaking changes bump the prefix; the old one keeps serving until removed deliberately).
Swagger UI and Postman can consume the same document. The page is fetched through the web
client, so `/api/v1` stays server-side; a same-origin `/api/openapi.json` handler proxies it
byte-for-byte (the browser never talks to `apps/api` directly). If the API is unreachable the
page says so with the error code and a reload link instead of showing an empty list — no
endpoint is invented. No new dependency: the reference is server-rendered from the JSON.

`help/factories/supported-projects` answers the most common question: the unit of work is a
repository diff verified by checks. In scope: application code, tests, documentation,
configuration, database migrations, Terraform modules and reviewed `terraform plan` output.
Out of scope: applying infrastructure (the factory opens a PR; the merge queue lands the code,
no cloud credentials reach a run), physical actions, and artefacts no check can verify —
those get a proposal at most. The mechanism is stated end to end (branch → PR → checks →
merge queue) and the entry is linked from the quick start, the factory how-tos section and
the add-a-factory how-to. The seven `curl http://localhost:8080/<resource>` examples in help
are now `/api/v1/...` (the health examples stay unversioned).

Sidebar footer fix (`web-console` spec: "Pinned sidebar footer"): the sidebar is
`sticky top-0 h-screen` with `shrink-0` header/footer blocks, and the nav list is the only
scroll area (`min-h-0 flex-1 overflow-y-auto`) with its scrollbar hidden (`.sidebar-scroll`).
API and Help are part of the main menu rather than a separate footer block; the account block
stays pinned at the bottom. On long pages such as `/help/quick-start` the account footer stays
visible without scrolling, and the sidebar never grows with the page. The rail starts expanded
and collapses to a 80px icon strip via the header toggle.

Verification (2026-10-31):

```
bun run ci                     → typecheck clean; 481 pass / 122 skip / 0 fail
                                 (incl. footer-nav parity + supported-projects content tests)
cd apps/web && bunx playwright test → 38 passed (34 existing + 4 help: API nav → reference
                                 (resource groups, method/path/params/codes, raw doc really
                                 served); footer visible + pinned on /help/quick-start;
                                 `?` on /help/api resolves; supported projects reachable)
UI_AUDIT=1 bunx playwright test audit-deep.spec.ts → 36 routes, 0 overflow, 0 console errors
bash scripts/smoke.sh          → SMOKE PASSED (backend unchanged; /health + /api/v1 paths)
```

Caveats: the API reference reflects whatever the document declares — a wrong summary is a
documentation bug, not a rendering bug; auth is still not modelled (Phase 6b), so the document
declares no security scheme. `/api/openapi.json` is a proxy of the backend document, not a
second copy.

### In-product help centre (web-console, 2026-10-31)

The console is now self-documenting. `apps/web/src/lib/help.ts` is a typed registry
(`{slug, title, section, status, summary, pageHref?, blocks, related}`) with five Diátaxis
sections: quick start, concepts, menu reference, setup how-tos and troubleshooting. 36 entries
at the time (38 now, after the API and supported-projects additions above):
one per top-level nav item (New Chat, Inbox, Work items, Runs, MCPs and apps, Secrets, Users) and
per factory page (Dashboard, Agents, Automations, Scorers, Self-improvement, Benchmarks, Definition,
Gates, Merge queue, Settings); eight concept entries (definitions as code, work-item lifecycle,
gates and autonomy, runners and sandboxes, scoring and calibration, benchmarks and attestation,
self-improvement and canary, merge queue); five how-tos (add a factory, connect GitHub, choose the
model through the environment, register a secret, add an MCP server); five troubleshooting entries
(run will not start, gate stuck, benchmark refused, canary rollback, secret unresolved). Every entry
carries an honest status — Users says it is a Phase 6b stub, and compose's fake harness/forge/stub
judge is stated wherever it changes the observable result.

`/help` lists the sections with descriptions and a client-side filter over title/section/summary;
`/help/<slug>` renders prose, ordered steps with copy-paste commands and an expected observable
result per step, code blocks, callouts, checklists and related links, plus a link back to the page it
describes. `/help/quick-start` carries three hand-built diagrams (inline SVG pipeline, CSS factory
anatomy, CSS gate resolution — no diagram dependency), commands from `docker compose up` to a merged
work item, and a "what success looks like" checklist.

Contextual help: a shared sticky header (root layout) carries a `?` control on every page; the
route→slug map lives in `help.ts`, factory routes default to Dashboard, and unknown routes fall back
to `/help` instead of 404. The accessible name names the page ("Help for Gates"). The sidebar has a
`Help` entry above the account footer, and the dead
`<span title="Creating factories is not wired yet">+</span>` is now a link to `/help/factories/add`
with the accessible name "Add a factory (git-backed)".

Maintenance is enforced: `apps/web/src/lib/help.test.ts` fails when a `TOP_NAV`/`FACTORY_NAV` item
loses its entry or a slug is duplicated, and AGENTS.md now requires a feature/page/route change to
update the matching help entry, the menu reference and (when the first-run flow changes) the quick
start in the same OpenSpec change.

Verification (2026-10-31):

```
bun run ci                     → typecheck clean; 470 pass / 122 skip / 0 fail (incl. 10 help-registry
                                 tests: nav parity, unique slugs, honest stub status, diagrams, routing)
docker compose up -d --build   → api, worker, web, postgres, temporal healthy
bash scripts/smoke.sh          → SMOKE PASSED (unchanged assertions; nav still renders)
cd apps/web && bunx playwright test → 34 passed (31 existing + 3 help: nav → index → filter →
                                 quick start diagrams/checklist; `?` on Chat/Gates/Self-improvement +
                                 unknown-route fallback; `+` → add-factory how-to, dead span gone)
UI_AUDIT=1 bunx playwright test audit-deep.spec.ts → 35 routes, 0 overflow, 0 console errors
```

Caveats: help content is prose checked against this document, not generated from code; the only
automated freshness guard is nav parity (a capability can change without a failing test — the
AGENTS.md rule is the process guard). The filter is client-side over 38 rows, no server index.


### UI audit + model configuration (ADR-028/ADR-029, 2026-10-30)

A 33-route UI audit found seven defects; all are fixed and asserted in Playwright. Gates copy
now distinguishes "not required because human gates remain" from "a passing attestation
matches", so it can no longer contradict the suite rows. Every factory page renders one
heading source (`alias` → directory name), including Benchmarks and Self-improvement, and the
lights-off demo has its own `name`/`alias` (`example-lights-off`, "Example — lights off").
The Definition page wraps long config values (`break-all` + `min-w-0`) so the 1280px viewport
no longer overflows (audit: 33 routes, zero overflow, zero console errors). MCP counts
pluralise (`1 server`), Self-improvement says "Canary authority is enabled" and leaves
active-rollout state to the canary panel, and `GET /secrets` attributes every reference to its
factory so two factories referencing the same name render as separate rows.

Models are now configuration (ADR-028): `model` accepts `env:[A-Z_][A-Z0-9_]*`; validation
refuses a malformed name with `invalid_value`; resolved configs report `{ref, value, source}`;
an unset variable is the non-fatal warning `model_env_unresolved`; run creation refuses it
with `model_unresolved` instead of forwarding `env:...`. The example factories declare
`env:FACTORY_MODEL` (foreman/spec/implement), `env:FACTORY_SMALL_MODEL` (triage/verify) and
`env:FACTORY_REVIEW_MODEL` (review); `.env`/`.env.example` set them to the operator's model.
`factory validate` prints every resolved model, and the chat composer's default comes from the
API's resolved factory default.

Dev-data hygiene (ADR-029): `scripts/smoke.sh` prints its target database, pauses the nightly
schedule it syncs and deletes the throwaway secret it registers; `scripts/reset-dev.sh
--yes` clears smoke/e2e/demo rows; integration suites default to `factory_test` (created by
`scripts/postgres-init.sql`, supplied by a Bun test preload), so demo and test rows no longer
mix.

Verification: `bun run ci` green (460 unit/integration-off tests, 122 skipped opt-in), compose
smoke green, 31 Playwright flows green, deep audit 33 routes / 0 overflow / 0 console errors.

### Phase 6a — secrets registry + MCP wiring (ADR-026/ADR-027, 2026-10-30)

Schema (`packages/core`): `mcp.servers` on `factory.yaml` (name, `transport: stdio|http`,
`command`/`args`/`env` for stdio, `url`/`headers` for http, where `env`/`headers` map a runtime key
to a secret **name**) and `agents[].mcp` as the per-agent allow list. The legacy `mcpServers` map and
allow list still validate and are normalised into the same declaration, so existing definitions are
unchanged. Validation adds `invalid_value` (unknown transport, or stdio with a url / http with a
command), `secret_inline_rejected` (a credential-looking literal such as `sk-…`, `ghp_…`, `xoxb-…` in
`command`/`args`/`url`/`env`/`headers`), and `unknown_mcp_server` (an agent binding a server the
factory does not declare, naming both). `secret_unregistered` is a **warning**, emitted only when the
caller supplies the registered names, so a fresh checkout still validates. `factories/example` now
declares one stdio server (`github`, credential by reference) and binds it to the `implement` agent;
the canonical snapshot was regenerated.

Persistence: `014_secrets_mcp.sql` (the change text said `012`, but `012`/`013` are taken by
harden-runtime) adds `secrets` (name/provider/scope/description/rotation — no value column),
`secret_usage`, `run_secrets`, `mcp_servers`, `mcp_bindings`, `mcp_tests`. `registerSecret` refuses a
`value` with `secret_value_rejected` *before* any query; presence is a boolean from the env provider
reported as `resolved`/`unresolved` at read time; `deleteSecret` refuses `secret_in_use` while a
definition still references the name (the caller supplies the references it found in git);
`recordRunSecrets` is idempotent per `(runId, name)` and only increments usage for names that
actually resolved.

API: `GET/POST/DELETE /secrets`, `POST /secrets/:name/rotate` (metadata only), `GET
/secrets/:name/usage` (count, last run, per-run rows, referencing resources), `GET/POST
/factories/:name/mcp`, `POST /factories/:name/mcp/:server/test`. The lease activity records the
secret names a run resolved on the lease step and in `run_secrets` — never a value. The probe runs in
the worker/runner (`McpTestWorkflow` → `testMcpServerActivity` → `probeMcpServer`), resolves
credentials locally by name (execution allowlist, inference credentials refused), scrubs them from
errors and records transport/latency/error; a failure marks the server `unhealthy` while agents bound
to it still validate.

Adapter (`packages/adapters`): `buildOpencodeSessionConfig` renders `mcp` (`type: local` with
`command` + `environment: {KEY: "{env:NAME}"}`, `type: remote` with `url` + `headers`), a
`permission` map (`"<server>*": allow` for bound servers, `deny` for the rest) and the same globs on
the agent override. `Capabilities.mcp` is `true` for opencode; the fake adapter records the requested
wiring as `{supported: false, mode: 'recorded', servers, permissions}` instead of dropping it. The
contract test replays a recorded wiring fixture, asserts the payload shape and that a secret value set
in the environment never appears in it.

UI: **Secrets** lists name/provider/scope/presence/last rotation/last use with a register dialog,
rotate-by-reference and a delete that shows the referencing resources when refused; **MCPs and apps**
shows servers (transport, status, bound/denied agents, tool globs, credential names, last probe) with
an add-server dialog, a Test button and an agent-binding table. The Agents page shows bound servers
plus the allow/deny globs. Both nav items are no longer Phase-6 stubs; only Users remains a stub.

Verification (2026-10-30):

```
bun run ci                     → typecheck clean; 449 pass / 122 skip / 0 fail; both factories
                                 validate, export --check canonical (16 / 15 files)
integration (PG + Temporal)     → 534 pass / 1 skip / 0 fail (incl. new secrets.test.ts 3 unit +
                                 7 PG cases, secrets.integration.test.ts 7 cases: register →
                                 lease → usage, delete guard, MCP sync + fake-transport probe)
docker compose up -d --build   → api, worker, web, postgres, temporal healthy; 014 applied
bash scripts/smoke.sh          → SMOKE PASSED incl. §18 (register + presence, value refused,
                                 in-use delete refused, run usage row, MCP projection + probe,
                                 inline-secret definition rejected)
cd apps/web && bunx playwright test → 28 passed (25 existing + secrets create/delete, in-use
                                 refusal, MCP register + runner probe + agent binding)
```

Caveats: the registry verifies *presence*, not correctness — the first real run is the real test (the
UI says so). MCP tool globs are opencode-specific; other harnesses record them as capability flags
(best effort, no enforcement). The probe's stdio success criterion is transport-level ("exited 0" or
"still alive at the timeout"), not an MCP JSON-RPC handshake.

### Phase 3c — runtime hardening (ADR-024/ADR-025, 2026-10-30)

Routes (`apps/api`): `GET /autonomy?factory=` returns the declared policy (resolved gates, merge policy,
fully-autonomous + benchmark-gate flags), the live `enabled`/`paused` state with actor/reason/`updatedAt`,
the attestation status and the newest `autonomy.*` work-item event as evidence. A factory that was never
enabled reports `enabled: false` with a reason and a `null` timestamp (nothing is invented).
`POST /work-items/:id/cancel` takes `{actor, reason}`, records `cancel_requested_at`/actor/reason once,
Signals `cancelWorkItem`, and `FactoryWorkflow` cancels the in-flight stage child, ends `cancelled` and
writes exactly one `work_item.cancelled` event. A repeat returns the same terminal state and emits no
second event; a `done` item is refused with `invalid_state`. The workflow also re-reads the recorded
request before every dispatch, so a lost Signal cannot resurrect a cancelled item. The Gates page reads
`GET /autonomy` directly; the E2E cleanup cancels work items instead of rejecting a gate.

Automation attestation parity (`activities/automation.ts`): a scheduled fire resolves autonomy through the
same `benchmarkGateRequired` + `findBenchmarkAttestation(commit, configHash)` check the API uses. When the
gate cannot be satisfied (and there is no override) the item's `benchmarkGate.satisfied` is false, so only
human gates apply, and an `autonomy.attestation_missing` event records why. There is no silent downgrade.

Read-model rebuild (`packages/core/src/read-model/rebuild.ts` + `factory rebuild`): replays every
`runs/<runId>/events.jsonl` in `(runId, seq)` order, validates the sequence (must start at 1 and be
contiguous; a gap/duplicate/invalid line fails with `event_log_corrupt` naming the run and sequence before
any write), and upserts runs, the boundary steps (`persist-run`, `finish-run`) and events idempotently. The
diff reports missing/divergent rows and `orphaned` projection rows, which are never deleted. `--dry-run`
reports the same diff and writes nothing; a second run writes 0 rows. The log does not carry the factory or
definition commit, so an inserted run inherits them from the linked work item when the id encodes one and
otherwise records `unknown` rather than inventing values (ADR-024).

jsonb hygiene: repositories bind objects directly (Bun encodes a `jsonb` parameter once); the old
`JSON.stringify(...)::jsonb` path double-encoded every object. `011_jsonb_normalise.sql` rewrites legacy
double-encoded objects/arrays via `jsonb_typeof` detection and leaves plain strings/unparsable values alone.
`012_work_item_cancel.sql` and `013_canary_deployment.sql` add the cancellation and deployment columns.

Canary follow-ups: terminal rollouts keep the newest `CANARY_KEEP_TREES` (default 3) candidate trees; older
trees are removed and audited with `canary.gc`, and an in-flight rollout's tree is never removed. The canary
panel also has a manual prune control (`POST /factories/:name/canary/prune`). Metrics include an hourly
series per version (pass rate, runs, error rate) derived from `scores`/`runs`; empty buckets are `null` with
`no_runs_in_bucket` (or `no_scores_in_bucket`) and are drawn as gaps, not 0%. Promotion runs the optional
`improvement.deployHook` against a staged copy of the promoted definition: success records `deployed`, a
failing hook records `promoted_pending_deploy` with the error, and no hook records
`promotion_pending_deploy` (the local checkout was not updated). The rollout status stays `promoted` so
routing/readers are unchanged.

Local runner sandbox (`packages/runners/src/sandbox.ts`, ADR-025): `RUNNER_SANDBOX=exec` runs the harness
under a generated SBPL profile — `(deny default)`, reads of system paths + workspace, writes only to the
workspace, the run directory and `/private/tmp`, loopback bind/inbound allowed for the harness protocol, and
`network-outbound` denied unless the stage grants `networkPolicy: allowed`. A non-macOS host (or a missing
`sandbox-exec`) runs unconfined and records `runner.sandbox_unavailable` on the runner step (and in the
work-item event log for stage runs) with the platform and reason. The default stays `none`.

Flake hunt: the canary + improvement suites were looped 50× (integration + unit). The loop reproduced one
failure signature: the `CanaryWorkflow` could observe the terminal rollout written by a manual
rollback/promotion before processing its Signal, and then reported the rollout's *start* actor
(`itest`) instead of the decision actor (`grace`). The observation now reads the finalising actor from the
rollout evidence (`evidence.rollback`/`evidence.promotion`), so the outcome matches the audit event. A
second signature was test isolation: the canary integration suite reused a constant factory name, so prior
runs' scored runs leaked into the next observation window (a "no regression" rollout was auto-rolled back).
The suite now uses a per-process factory name and cleans its rows. After both fixes the 50× loop was green
(see verification).

Verification (2026-10-30):

```
bun run ci                     → typecheck clean; 415 pass / 106 skip / 0 fail
bun run test                   → 415 pass / 106 skip / 0 fail (521 tests across 60 files)
canary integration             → 4 pass (promote, pass-rate regression auto rollback, manual
                                 rollback race fixed, second start refused)
improvement integration        → 4 pass
factory-loop integration       → 9 pass (7 existing + cancel-while-gated + lost-Signal cancel)
automation integration         → 6 pass (4 existing + attestation missing + attestation present)
canary follow-ups              → 6 pass (GC keep N/protect active, hourly series + null buckets,
                                 deploy hook success/failure/no-hook)
jsonb hygiene (PG)             → 3 pass (round-trip + ->>, legacy row normalised, plain string kept)
flake loop (50×)               → 50/50 iterations (150 suite runs: canary + improvement integration,
                                 canary/improve unit): 0 fail (Temporal dev server restarted every
                                 5 iterations to bound its in-memory history)
docker compose up -d --build   → api, worker, web, postgres, temporal healthy
bash scripts/smoke.sh          → SMOKE PASSED incl. §17 (autonomy read, work-item cancel + repeat,
                                 rebuild --dry-run)
cd apps/web && bunx playwright test → 25 passed (23 existing + runtime-hardening: cancel from the
                                 board, Gates reads autonomy)
```

Caveats: the rebuild cannot reconstruct coarse steps other than the two boundaries and reports them as
orphaned; the deploy hook runs on the API/worker host with the staged tree path in `FACTORY_DEPLOY_STAGE`
(the hook decides how to install it), and the sandbox is macOS-only and deprecated by Apple (behind the
flag). `RUNNER_SANDBOX=exec` is not exercised in compose (Linux containers have no `sandbox-exec`); the
fallback path is recorded on the lease step.

### Phase 3b — GitHub forge + merge queue + automations (ADR-022/ADR-023, 2026-10-29)

Forge (`packages/forge`): `github.ts` implements the full `CodeForge` contract over REST with an injected
`fetch`. The token is resolved by **secret reference** at call time (`GITHUB_TOKEN` by default; the value
never appears in definitions, events or logs), GETs are ETag-cached, 5xx/network errors back off
exponentially, and a rate-limit response retries within a budget before surfacing `rate_limited` with the
reset time. `401/403` map to `auth_failed` (with the missing scope when GitHub reports it), `404` to
`not_found`, `405/409` to `checks_not_green` or `invalid_state`. `GITHUB_DRY_RUN=1` makes every mutation a
no-op that returns a synthetic result and emits `github.intended_action`; nothing leaves the process. The
shared contract suite runs against `FakeForge` and `GitHubForge` wired to a stateful stub seeded from
`test/fixtures/github/seed.json` (recorded responses); `RUN_GITHUB=1` opts into the real network. The
interface gained an optional `revert()` (a revert commit, never a force-push) — additive, so existing
backends are unaffected. `FakeForge.merge` now applies the branch diff since its creation base (a real
merge, not a tree replacement), and has deterministic stack-check hooks (`.ci-fail` marker, `setStackPending`).

Merge queue (`packages/merge` + orchestration): `ship` enqueues instead of merging when the factory's GitHub
integration sets `mergeQueue` (ADR-022); the engine is a deterministic **merge train** — merge, gate the
merged stack at the new head, keep it if green, otherwise revert just that merge (one commit) and mark the
PR `needs_human` with its failing checks while the rest of the batch lands. A stack that never reports
within `MERGE_CHECKS_TIMEOUT_MS` fails `checks_timeout` and the whole batch is reverted (nothing merges).
`MergeQueueWorkflow` is one durable workflow per factory (`USE_EXISTING`), and a unique partial index allows
at most one batch in flight. A human revert is a one-shot `MergeRevertWorkflow` (the forge lives in the
worker) audited with actor + reason. The queue key is the branch (`factory/<workItemId>`), so a reset forge
cannot dedupe a fresh PR against a stale row.

Persistence: `009_merge_and_webhooks.sql` (`integrations`, `merge_batches`, `merge_batch_items`,
`merge_events`, `webhook_deliveries`, `automation_schedules`, `automation_fires`) + repositories (idempotent
upserts; events deduped by `(batch, type, subject)`); `010_merge_queue_head_key.sql` moves the queue
idempotency key from the PR number to the branch. *(Task 4.1 named the file `008_…`; `008_canary.sql` already
existed, so it landed as `009`.)*

Webhooks (`apps/api`): `POST /webhooks/:provider` verifies `X-Hub-Signature-256` **before parsing**, caps the
body (`payload_too_large`), dedupes by `X-GitHub-Delivery`, skips bot senders by default (`skip_bots: all`),
applies repository/event/label/branch filters, frames payload text as untrusted data (`sourceRef.untrusted`)
and records every delivery (`accepted`/`ignored`/`rejected` + reason). Cron automations sync from the
definition into Temporal schedules (`POST /factories/:name/automations/sync`), pause when disabled, and fire
idempotently by `(scheduleId, fireAt)` into a derived work item id.

API: `GET /factories/:name/merge-queue`, `POST /merge-queue/revert`, `GET /factories/:name/integrations`,
`POST /integrations/github` (secret refs, repos, filters, dry-run, merge ownership, harness override),
`GET /factories/:name/automations`, `POST /factories/:name/automations/sync`,
`POST /factories/:name/automations/:automation/pause`, `GET /webhook-deliveries[/:id]`.

UI: Settings › GitHub connection (status, repos, webhook URL + secret refs, dry-run and merge-ownership
toggles, save form), a new **Merge queue** page (batch size, checks timeout, in-flight batch, waiting queue,
batches with PRs/checks/bisect evidence/events and a revert control), and Automations showing webhook URL +
secret ref, cron schedule status/last fire and webhook delivery counts with a sync button.

Verification (2026-10-29):

```
bun run ci                     → typecheck clean; 395 pass / 86 skip / 0 fail; both factories validate,
                                 export --check canonical (16 / 15 files)
forge contract (fake + github)  → 32 pass: same suite against the recorded-fetch stub; credential by
                                 reference, auth/rate-limit/protected-branch mapping, ETag 304s, dry run
                                 (no fetch, intended actions), revert restores the tree
merge engine (fake forge)      → 10 pass: green batch, bisect (clean subset + offender needs_human),
                                 checks_timeout (revert, nothing merged), manual revert, idempotent retry
merge queue integration (Temporal + PG, fake forge)
                               → 4 pass: green batch merged, red stack bisected (offender escalated),
                                 timeout reverted, manual revert workflow (audited, PR reverted)
automation integration         → 4 pass: schedule created/active, fire → derived work item, replay of the
                                 same fire is idempotent, disable pauses the schedule, operator pause
webhook API integration        → 9 pass: unsigned/forged rejected (no item), signed issue → forge item with
                                 sourceRef.untrusted, duplicate delivery ignored, bot skipped, non-matching
                                 ignored with reason, payload_too_large, integration + automations projections,
                                 token value refused as a secret ref
full chain integration         → 2 pass: signed webhook → work item → loop (fake harness) → PR → enqueued →
                                 merge queue merged → item done + merge.merged + PR merged in the forge
docker compose up -d --build   → api, worker, web, postgres, temporal healthy
bash scripts/smoke.sh          → SMOKE PASSED incl. §15 (integration by secret reference, unsigned webhook
                                 rejected, signed webhook creates a forge item, duplicate ignored) and §16
                                 (merge queue projection, nightly cron schedule active, automations webhook)
cd apps/web && bunx playwright test → 23 passed (20 existing + merge-queue: settings/integrations, queued PR
                                 merged by the queue and shown on the page, automations cron status + pause)
```

Caveats: the compose stack runs the fake forge, so a "merge commit" is a content-hash SHA and the webhook
integration sets `harness: fake`/`runner: fake` (a real GitHub connection needs a PAT in `GITHUB_TOKEN`, a
`GITHUB_WEBHOOK_SECRET`, and the factory's own harness/model). The GitHub REST path is wired but only
exercised offline (`RUN_GITHUB=1` opts in). A merged PR cannot be merged twice, so bisect is a merge train
rather than "revert the batch and re-merge"; a requeued PR would need a new PR. *(Phase 3c closed the two
caveats that used to follow here: automation items now consult the benchmark attestation exactly like
manual items, and `source_ref`/`input` are encoded once at the repository boundary — legacy double-encoded
rows are normalised by `011_jsonb_normalise.sql`.)*

**Observed flake (resolved):** the Phase-5b note (a canary integration assertion that did not reproduce)
was hunted with a 50× loop in Phase 3c. Two signatures were found and fixed: (1) a manual rollback race in
`CanaryWorkflow` where the workflow observed the terminal rollout before the Signal and reported the start
actor instead of the decision actor; (2) canary integration test isolation (a constant factory name let
prior runs' scores leak into the next observation window, auto-rolling back a "no regression" rollout).
Evidence: 50 consecutive loops of the canary + improvement suites (integration + unit) green after the
fixes; see the Phase 3c section.

### Phase 5b — canary rollout (ADR-021, 2026-10-29) A `canary` authority now starts a real
rollout: `CanaryWorkflow` publishes the composed candidate as a candidate version (materialised tree +
branch + draft PR on the definition repo), new work items are assigned stable or candidate exactly once
by `sha256(workItemId) % 100 < canaryPercent`, the observation window compares pass rate and
incident/failure rate per pinned commit, and the rollout is promoted (PR merged) or rolled back
automatically beyond `rollbackThreshold`. Manual promote/rollback work regardless of the window and are
audited (`canary.started` / `canary.promoted` / `canary.rolled_back` with reason + evidence). The
`canary_not_available` refusal is gone from the apply path (ADR-021 implemented).
### Phase 5b — canary rollout (ADR-021, 2026-10-29)

Routing: `packages/core/src/improvement/canary.ts` — `canaryBucket()` (sha256 → 0..99) and
`assignCanaryVersion()`, a pure deterministic function; `evaluateCanaryObservation()` is the single
definition of regression (pass-rate drop or incident/failure-rate rise beyond the threshold, plus an
explicit `insufficientData` flag). `008_canary.sql` adds `work_items.canary_rollout_id` +
`definition_version`, rollout evidence/commit/root/PR columns and an append-only `canary_events` log
(deduped by `(rollout_id, type, subject)`); proposal statuses gain `canary`/`rolled_back`.

Orchestration: `CanaryWorkflow` (publish → durable observation timer → promote/rollback, `condition()`
for manual Signals) + activities (`publishCanaryCandidateActivity`, `observeCanaryActivity`,
`promoteCanaryActivity`, `rollbackCanaryActivity`, `failCanaryActivity`). Publishing materialises the
composed definition under `runs/canary/<rolloutId>/definition` (validated), commits it on a
`canary/<rolloutId>` branch and opens a draft PR; candidate work items run from that tree and pin the
candidate commit. Observation reads `scores` + `runs` grouped by `definition_commit` over the window.
Promotion merges the candidate PR; rollback leaves it open with an audit comment. One rollout per
factory may be in flight (`pending`/`active`); a second start is refused with `canary_active`, and the
improvement workflow lets the highest-impact candidate own it (others stay `open`).

API: `POST /proposals/:id/apply` starts a real rollout for `canary` (returns `decision.action: canary`
+ the pending rollout + workflow); `POST /factories/:name/canary` (explicit start with optional
`canaryPercent`/`observationWindowHours` override), `GET /factories/:name/canary` (active rollout,
split, window countdown, candidate-vs-stable metrics, history + events), `POST /canary/promote`,
`POST /canary/rollback`. `POST /work-items` returns the assigned `definitionVersion` +
`canaryRolloutId` and pins the candidate commit for candidate items. `POST
/factories/:name/improvement/run` accepts a `canaryPercent` override for the rollout it starts.

UI: Canary panel on Self-improvement (candidate vs stable, traffic split + counts, live window
countdown, score comparison with deltas, promote/rollback with actor + reason, history with audit
events) and a canary card on Gates reflecting the active/last rollout. The Phase-5b placeholder note
is gone.

Verification (2026-10-29):

```
bun run ci                     → typecheck clean; 347 pass / 63 skip / 0 fail
bun test packages/core/test/canary.test.ts → 9 pass (hash determinism, split, clamp, regression rules)
canary orchestration (Temporal + PG, fake forge)
                               → 4 pass: publish → promote (PR merged, canary.started/promoted),
                                 pass-rate regression → auto rollback (evidence -1.0 delta),
                                 manual rollback (immediate + Signal + idempotent), second start
                                 refused with canary_active
canary API (PG, no worker)     → 3 pass: start → 8+ items routed by hash (candidate pins commit +
                                 rollout) → promote → stable again + no_active_canary; manual rollback
                                 → stable routing; apply starts a pending rollout (10%) instead of
                                 canary_not_available, rollback cancels it
docker compose up -d --build   → api, worker, web, postgres, temporal healthy
bash scripts/smoke.sh          → SMOKE PASSED incl. §14: improvement pass on example-lights-off starts
                                 a 100% canary, one item routed to the candidate commit, manual
                                 rollback, canary.started + canary.rolled_back, stable routing after
cd apps/web && bunx playwright test → 20 passed (19 existing + canary: panel → candidate routing →
                                 manual rollback → gates state → stable routing)
```

Caveats: promotion merges the candidate PR in the definition repo but does not rewrite the local
checkout (ADR-012: the console/API never write the worktree), so the on-disk definition updates on the
next checkout/deploy. Candidate trees live under `runs/canary/` (not garbage-collected yet). The
compose stack uses the fake forge, so a "candidate commit" is a content-hash SHA, not a git commit.

### Phase 5a — self-improvement (ADR-020/ADR-021, 2026-10-29)

Schema: `improvement` block in `factory.yaml` (`authority`, `canaryPercent`, `rollbackThreshold`,
`observationWindowHours`, `maxProbes`), validated with `invalid_value` / `missing_field` (canary requires
`canaryPercent` 1–100 and `rollbackThreshold`), defaulting to `propose_only`; `resolveImprovement()`
reports the resolved config (including `source: declared|default`), `factory validate` prints it, and
`factories/example` (propose_only) / `example-lights-off` (canary 10%, rollback 0.1) plus the canonical
snapshot are updated.

Engine (`packages/evals/src/improve`): eligibility (min scored runs + calibrated judges; any
uncalibrated judge blocks), deterministic observer (invariant edit to `agents/*/agent.md` + domain edit to
`scorers/*` or `skills/*`; evidence = run ids, failure counts, scorer rationales; impact = failed runs ×
(1 + cost)), dedupe/cluster by files + failure signature with impact ranking, blast-radius guard
(`edit_out_of_scope` for `factory.yaml`, `runners/*`, `benchmarks/*`, source and anything outside the
allowed paths), contrastive probe (same work item + prompt hash + scorer + rubric hash; a positive delta
wins; mismatched inputs throw `probe_input_mismatch`), compose (winning edits → canonical files + diff +
`candidateHash`, validated by loading a scratch tree), authority routing, and the experience library
(`INDEX.md` + `EXPERIENCE.md` `{cue, lesson, evidence, confidence}`, per-factory isolation, opt-in
promotion).

Persistence: `007_improvement.sql` (`improvement_runs`, `proposals`, `proposal_edits`, `probes`,
`lessons`, `improvement_events`, `canary_rollouts`) + a repository (dedupe on `(run, cluster_key)`, edits
on `(proposal, kind, path)`, probes on `(proposal, edit, work item)`, events on `(run, type, subject)`).

Orchestration: `ImprovementWorkflow` (eligibility → observe → dedupe → probe → compose → decide) with
activities for each step, deterministic probe hook (`setImprovementProbeRunner`), fake-forge PR/merge,
and `improvement.started` / `proposal.created` / `probe.completed` / `candidate.published` events.
Lessons are mirrored in `runs/experience/<factory>/` so the read-only definition mount is respected.

API: `GET /factories/:name/improvement`, `POST /factories/:name/improvement/run`,
`POST /factories/:name/improvement/authority` (diff + `confirm` → PR, never a worktree write),
`GET /improvements/:id`, `GET /proposals`, `GET /proposals/:id`, `POST /proposals/:id/decision`,
`POST /proposals/:id/apply` (`canary` → 409 `canary_not_available` in Phase 5a; superseded by the
Phase 5b rollout above), `GET /lessons`
(factory-scoped by default), `POST /lessons/:id/promote`, `POST /canary/rollback` (5b refusal in 5a).

UI: Self-improvement page with authority selector (preview diff → confirm → PR), eligibility card,
ranked proposals (impact, evidence, probe results, before/after diff, accept/reject/apply), last-run
summary, and the lessons library with promote-to-shared; honest empty states everywhere.

Verification (2026-10-29):

```
bun run ci                     → typecheck clean; 337 pass / 52 skip / 0 fail
bun run test packages/evals/test/improve.test.ts        → 25 pass (scope, observer, dedupe, probe, compose, authority, lessons)
bun test apps/api/test/improvement.test.ts              → 14 pass (validation, scope rejection, authority routing, isolation)
improvement integration (Temporal + PG, fake forge, stub corpus)
                               → propose_only PR, auto-merge refusal without attestation, canary_not_available, ineligible skip
```

### Phase 4b — benchmarks, Pareto and attestation (ADR-018/ADR-019, 2026-10-29)

`packages/evals` (new `benchmark.ts`): suite/task loader with stable validation codes (`invalid_sha`,
`too_many_configurations`, `duplicate_tasks`, `duplicate_configurations`, `benchmark_task_mismatch`),
normalized configuration matrix, `configHash = sha256(matrix + definitionCommit)`, cost estimator
(trials × median comparable run cost, fallback when no data, confirmation threshold), aggregation
(`passRate`, `weightedScore`, `sampleSize`, `passingCount`, `costUsd`, `errors`, `skipped`,
`uncalibrated`), and a Pareto frontier with `highest_performance` / `most_efficient` / `lowest_cost`
labels; a single recommendation is produced only on dominance. Unit tests cover hash stability,
validation codes, estimate/cap arithmetic, aggregation, dominance and trade-offs.

Persistence: `005_benchmarks.sql` (`benchmark_runs`, `benchmark_trials`, `benchmark_results`,
`benchmark_attestations`, `benchmark_events`) + `006_benchmark_attestation_partial.sql` (partial runs
record a reporting-only attestation), and a repository (create run, upsert trial by
`(run, configuration, task)`, aggregate results, attestation lookup by `(factory, commit, configHash)`,
deduped events, median comparable run costs).

Orchestration: `BenchmarkWorkflow` fans out child `RunWorkflow`s in deterministic concurrency batches;
each trial gets a fresh fake-forge repo, a pinned full SHA + definition commit, `hermetic: true`,
`networkPolicy: denied`, and a `network_denied` failure for tasks tagged `requires-network`. A failed
trial is recorded and excluded; the hard cap skips remaining trials with `budget_exhausted` and the run
completes with partial results. Activities: `estimateBenchmarkCostActivity`, `startBenchmarkTrial`,
`finishBenchmarkTrial`, `failBenchmarkTrial`, `skipBenchmarkTrial`, `aggregateBenchmarkActivity`,
`attestBenchmarkActivity`; `benchmark.started` / `benchmark.completed` are append-only and deduped by
`(benchmark_run_id, type)`. Trial scoring reuses the Phase 4a scorer path (deterministic + judge +
`persistScore`), so calibration/provenance are identical to ordinary scoring.

API: `GET /factories/:name/benchmarks` (suites, matrix hash, latest run, attestations, gate),
`POST /factories/:name/benchmarks/:suite/run` (`dryRun` estimate, `cost_confirmation_required` above
the threshold, hard `maxCostUsd`, starts the workflow), `GET /benchmarks/:id` (run, trials, results,
events, aggregate, frontier, labels, recommendation, attestation), `GET /factories/:name/attestations`,
`GET /factories/:name/benchmark-gate`. `POST /autonomy` now refuses with
`benchmark_attestation_missing` unless a passing, calibrated, non-partial attestation matches the
running commit + configHash; the explicit `{actor, reason}` override remains.

UI: Benchmarks page (suites, configurations, pinned tasks, `configHash`, latest run, attestation
badge), run dialog (configuration/task selection, estimate, confirmation, hard cap), results matrix,
Pareto scatter (pass rate vs cost), labels/recommendation, per-trial drill-down to the child run, and
a Gates page attestation card with status + link; the enable button reflects the attestation.

Verification (2026-10-29):

```
bun run ci                     → typecheck clean; 291 pass / 46 skip / 0 fail
benchmark orchestration (Temporal + PG, fake harness/forge, stub judge)
                               → 4 pass: 2 tasks × 2 configs → 4 ok trials, 2 results, frontier,
                                 attestation + benchmark.started/completed; zero cap → all skipped
                                 budget_exhausted; one requires-network trial → error recorded,
                                 the other trial still runs (partial failure tolerated)
benchmark API (PG + Temporal)  → 5 pass: suites/hash/gate projection, dry-run estimate,
                                 cost_confirmation_required → confirmed start, zero cap refused,
                                 stale attestation → benchmark_attestation_missing, matching
                                 attestation → autonomy enabled
docker compose up -d --build   → api, worker, web, postgres, temporal healthy
bash scripts/smoke.sh          → SMOKE PASSED incl. calibration + 1 task × 2 configs benchmark
                                 (2 trials, 2 results, pass rate 1) + attestation row
cd apps/web && bunx playwright test → 19 passed: benchmarks (run → results → frontier →
                                 attestation → autonomy enabled), lights-off override/attestation,
                                 chat, inbox, runs, definition, scoring, metrics
```

Caveat: compose runs benchmarks on `BENCHMARK_HARNESS=fake` + `BENCHMARK_RUNNER=fake` with the stub
judge; a real benchmark needs the factory's harness/model and a passing calibration. A partial matrix
(task/config subset) records an attestation for reporting but is marked `partial` and the autonomy
gate ignores it. Trials are hermetic replays, not production replays (no recorded-tool-response replay
in v1).


### Phase 4a — scoring and metrics (ADR-016/ADR-017, 2026-10-29)

`packages/evals` (new): scorer registry loaded from the git-backed definition, class inference
(`deterministic` when the rubric body declares a `checks:` block, otherwise `judge`), content-addressed
`rubricHash`, deterministic tests/build/lint scoring from `artifacts/checks.json` or tool-call events
(`missing_artifact` → `error`, run untouched), LLM-judge scoring with strict label parsing and full
provenance (`judgeModel`, `judgeModelVersion`, `rubricHash`, `promptHash`, tokens, cost), deterministic
sampling by `sha256(runId)`, cadence, per-factory daily budget (`budget_exhausted`), and calibration
(exact + within-tolerance agreement, per-label confusion, pass/fail verdict, `insufficient_data` below
the minimum size). `JudgeClient` has a deterministic `stub` (used everywhere in CI) and an `openai`
implementation for OpenAI-compatible endpoints (real path exists, not exercised in CI).

Persistence: `packages/core/migrations/004_scoring.sql` (`scorer_definitions`, `score_runs`, `scores`,
`score_evidence`, `score_events`, `calibration_sets`, `calibration_items`, `calibration_results`) +
repository functions (upsert scorer, record score with evidence, query by run/item/stage/scorer/factory,
aggregate pass rate, budget accounting, calibration CRUD) + derived metric queries (throughput,
cost/PR total + per stage + unattributed, cycle time, time to first human review, touchpoints/PR,
automation %, defect rate from forge check events; null + reason for missing data).

Orchestration: `ScoringWorkflow` (on-demand via `POST /scoring`, scheduled via a Temporal Schedule per
factory through `ensureScoringSchedule` / `scripts/scoring.ts`) + activities (`createScoreRun`,
`listScorableRuns`, `planScoring`, `runDeterministic`, `runJudge`, `persistScore`, `finishScoreRun`),
`score.completed`/`score.skipped` events deduped by `(score_id, type)`, and failure isolation (a scorer
failure is an `error` score; a run is never failed by scoring).

API: `GET /factories/:name/scorers`, `GET /scores?...`, `GET /scores/:id`, `POST /calibration`,
`GET /calibration/:scorer`, `GET /factories/:name/metrics?window=`, `POST /scoring`.

UI: real Scorers page (registry, class, labels, passing score, sampling, judge model, calibration
badge + panel with agreement/confusion/verdict/insufficient-data), score detail (label/score/rationale/
evidence links/provenance/cost/calibration), dashboard metric cards with definitions, window switch and
per-stage cost breakdown, and scores attached to run detail. Missing data is `null` + reason; nothing is
fabricated.

Verification (2026-10-29):

```
bun run ci                     → typecheck clean; 274 pass / 33 skip / 0 fail
scoring integration (Temporal + PG, stub judge)
                               → 3 pass: deterministic + judge score on a fake-harness run with
                                 provenance + score.completed; missing_artifact + failing judge are
                                 error scores (run stays ok); budget=0 → judge skipped, deterministic ok
calibration API integration (PG) → 2 pass: insufficient_data below the minimum size, then a passing
                                 verdict with confusion + rubric hash + judge version; bad label → 400
docker compose up -d --build   → api, worker, web, postgres, temporal healthy
bash scripts/smoke.sh          → SMOKE PASSED incl. scoring a completed run (score row,
                                 score.completed, provenance, uncalibrated flag)
cd apps/web && bunx playwright test → 18 passed: scoring spec covers scorers page, score detail,
                                 run scores, dashboard metric cards + per-stage cost
```

Caveat: the compose stack runs `SCORING_JUDGE_MODE=stub`; the OpenAI judge path needs
`OPENAI_BASE_URL`/`OPENAI_API_KEY` and is not exercised in CI. Judge scores are `uncalibrated` until a
golden-set calibration passes for the current rubric hash + model; the benchmark gate surfaces that
state, and Phase 4b will consume it.


### Phase 2b fix — human permission waits are workflow-level durable waits (ADR-013, 2026-10-29)

Defect found in Phase 2b E2E: the worker ran 8 concurrent activities and `pumpEvents` blocked
*inside* the activity while polling `run_permissions`, so eight abandoned permission-blocked runs
consumed every slot and no new run started — contradicting the run-lifecycle promise that human
gates are durable waits that cost nothing.

Fix: `pumpEvents` is now a **segment** that returns as soon as `permission.requested` is emitted
(canonical event persisted exactly once). `RunWorkflow` registers a Temporal **Update**
(`submitPermissionDecision`; Signal `permissionDecision` as fallback) at workflow start, waits on
workflow state with `condition()` (no activity slot, no fixed timeout), forwards the decision via
`respondPermission`, and resumes the cached adapter stream from `lastSeq`. A configurable SLA
(`PERMISSION_TIMEOUT_MS`, default 30 min) auto-denies and ends `error`; a 15s cancellation probe
catches a cancel recorded in Postgres when the Signal is lost. `POST /runs/:id/permissions/:requestId`
keeps its response shape and now delivers the Update/Signal after recording the read-model decision.
Worker concurrency is env-tunable (`WORKER_MAX_CONCURRENT_ACTIVITY_TASKS`,
`WORKER_MAX_CONCURRENT_WORKFLOW_TASKS`; code default 100/100, compose dev keeps 8 so the smoke test
is a genuine regression check).

Verification (2026-10-29):

```
bun run ci                     → typecheck clean; 158 pass / 6 skip / 0 fail
integration (Temporal + PG)    → 3 pass: blocked run does not block a second (concurrency 2),
                                 8 blocked runs + a ninth run completes, cancel-while-waiting → cancelled
docker compose up -d --build   → api, worker, web, postgres, temporal healthy
bash scripts/smoke.sh          → SMOKE PASSED incl. scripts/smoke-permissions.sh
                                 (8 blocked runs parked, 9th reached ok, cancel → cancelled, deny → ok,
                                  exactly one permission.requested + one terminal event)
worker restart mid-permission  → decision delivered, run resumed, 14 unique seqs 1..14, status ok
```

Caveat: the decision path needs Temporal reachable; a failed delivery leaves the run to the SLA
timer. After a worker restart the adapter session is recreated — durable decisions are re-forwarded
best-effort and events stay deduplicated by `(runId, seq)`.

### Phase 2a verification

```
docker compose up -d --build   → postgres, temporal, api, worker all healthy
bash scripts/smoke.sh          → SMOKE PASSED: 14 SSE events, exactly 1 terminal, permission approved,
                                 replay resumed at seq 4, proxy allowlist + token revoked,
                                 events.jsonl (14) + patch.diff present
bun run ci                     → typecheck clean (6 packages/apps); 139 pass / 1 skip
worker kill + restart          → run resumed, status ok, seq 1..14 unique
```

Notes: opencode's installed v2 API moved under `/api` (published docs still describe v1); the adapter
follows the installed CLI and tolerates v1 event names. The per-run proxy token reaches the harness via the
launch command, not `spec.harness.env`, so the `OPENAI_*` env ban still holds; it is visible to host-level
`docker inspect` (same trust boundary as the host) and revoked at run end. The real opencode path is wired
but not exercised in CI (needs runner image + credentials); the local backend has no `sandbox-exec`
isolation yet.

## Done

- [x] `git init`, scaffold commit
- [x] `openspec init --tools opencode --profile core` (schema: spec-driven)
- [x] `initial_idea.md` (brief + clarifications + "web chat is the harness" addendum)
- [x] `AGENTS.md`, `docs/GLOSSARY.md`, `docs/DECISIONS.md` (ADR-001/002/004/007/008 accepted)
- [x] `docs/ARCHITECTURE.md` (v0.1) and `docs/ROADMAP.md` (phases 1–6)
- [x] Research: `research/warp-factories.md`, `research/ecosystem.md`, `research/talks.md`
- [x] `tools/yt/` YouTube toolkit + `research/videos/x-PK3yx_MJg/` (transcript, 131 frames, ANALYSIS.md)
- [x] **Phase 1**: `packages/core` (schema/loader/gates/diff/version + migration), `packages/cli`
  (`factory validate|export|import|diff|fmt|version`), `factories/example` + `factories/example-lights-off`,
  79 tests passing, round-trip byte-identical, `export --check` canonical
- [x] Skills vendored (5 MIT + project-local `factory-definition`), `docs/SKILLS.md`
- [x] Testing conventions: Playwright E2E + `docker compose` smoke tests

### Phase 2a — durable runs, adapters, runners, API (2026-10-28)

- [x] `packages/adapters`: canonical `FactoryEvent` union + Zod, `HarnessAdapter`, capability flags,
      `FakeAdapter`, `OpencodeAdapter` (HTTP+SSE, `/api` v2 surface), contract tests vs recorded fixtures
- [x] `packages/runners`: `RunnerBackend` (`lease|exec|heartbeat|artifacts|kill`), docker + local backends,
      secret allowlist + inference ban, artifact capture by path+sha256
- [x] `packages/orchestration` (new): Temporal `RunWorkflow` + activities (`leaseRunner`, `startHarness`,
      `pumpEvents`, `persistRun`, `appendEvent`, `appendTerminalEvent`, `collectArtifacts`, `killRunner`,
      proxy token issue/revoke), `worker.ts`, client. Idempotent by `runId+stepId` and `(runId, seq)`
- [x] `apps/api` (new, Bun + Hono): `/health`, `/runs` (+detail, list), `/runs/:id/events` SSE with
      `Last-Event-ID` replay, `/runs/:id/cancel`, `/runs/:id/permissions/:requestId`, `/chat`,
      OpenAI-compatible inference proxy at `/v1/*`
- [x] Persistence: `packages/core/migrations/002_runs_events.sql` (runs, run_steps, events,
      run_permissions, proxy_tokens, proxy_attempts) + idempotent `scripts/migrate.ts` (Bun SQL)
- [x] Run directory layout `runs/<runId>/{events.jsonl,patch.diff,artifacts/}`
- [x] `compose.yaml` (postgres 16, Temporal dev server + UI, api, worker; healthchecks, bind-mounted
      repo + runs), `.env.example`
- [x] `scripts/smoke.sh`: health → migrate → fake-harness chat run → proxy checks (stub upstream,
      allowlist, streaming, revocation) → SSE ≥3 events + one terminal → approve permission →
      replay from `Last-Event-ID` → run dir assertions
- [x] `scripts/ci.sh` + root `typecheck` extended to `packages/orchestration` and `apps/api`
- [x] **Phase 2b fix (ADR-013)**: permission waits moved out of activities into workflow-level
      durable waits — `pump.ts` segment loop, per-run stream cache, Update/Signal decision channel,
      env-tunable worker concurrency, `scripts/smoke-permissions.sh`, pump + integration tests

### Phase 3b — GitHub forge, merge queue, webhooks (2026-10-29)

- [x] `packages/forge/src/github.ts`: REST `CodeForge` (injected `fetch`, secret by reference, ETag cache,
      backoff, `auth_failed`/`rate_limited`/`not_found`/`protected_branch`), dry run with intended actions,
      optional `revert()`; contract suite vs `FakeForge` + a recorded-fetch stub (`RUN_GITHUB=1` opt-in)
- [x] `packages/merge`: deterministic merge-train engine (batch, gate the merged stack, bisect to the
      offender, revert on red, manual revert) + unit tests
- [x] `packages/orchestration`: `MergeQueueWorkflow` (one per factory, `USE_EXISTING`), merge activities,
      `MergeRevertWorkflow`, `AutomationWorkflow` + schedule sync/pause client; loop `ship` enqueues when
      `mergeQueue` is set
- [x] `packages/core`: `009_merge_and_webhooks.sql` + `010_merge_queue_head_key.sql` and repositories
      (integrations, merge batches/items/events, webhook deliveries, automation schedules/fires)
- [x] `apps/api`: `POST /webhooks/:provider` (HMAC before parsing, size cap, dedupe, bot skip, filters,
      untrusted framing), integration/merge-queue/automation routes, webhook delivery log
- [x] `apps/web`: Settings GitHub connection form, Merge queue page (+ nav), Automations webhook/cron status
      with a schedule sync button
- [x] Tests: forge contract (offline), merge engine, merge-queue/automation/webhook integrations, the full
      webhook → loop → PR → merge queue chain, smoke §15/§16, Playwright merge-queue spec

### Phase 3c — runtime hardening (2026-10-30)

- [x] `apps/api`: `GET /autonomy` (declared policy + live state + newest event, no invented timestamps) and
      `POST /work-items/:id/cancel` (actor/reason, idempotent, `invalid_state` for terminal items);
      `FactoryWorkflow` cancels the stage child and writes one `work_item.cancelled`
- [x] Gates page reads `GET /autonomy`; E2E cleanup cancels work items instead of rejecting gates
- [x] Automation attestation parity: same benchmark-attestation resolution; `autonomy.attestation_missing`
      when the gate cannot be satisfied (human gates, no silent downgrade)
- [x] `packages/core/src/read-model/rebuild.ts` + `factory rebuild --from runs/ [--dry-run]`: replay in
      `(runId, seq)` order, idempotent upserts, missing/divergent/orphaned diff, `event_log_corrupt` refusal
- [x] jsonb: single encode at the repository boundary; `011_jsonb_normalise.sql` rewrites legacy rows
- [x] Canary: candidate-tree GC (keep last `CANARY_KEEP_TREES`, never an active tree), hourly series with
      null buckets, `deployHook` promotion (deployed / promoted_pending_deploy / promotion_pending_deploy),
      UI series chart + prune control + deployment state
- [x] Local runner: generated SBPL profile behind `RUNNER_SANDBOX=exec`, per-stage network grant,
      `runner.sandbox_unavailable` fallback on unsupported hosts
- [x] Flake hunt: 50× canary + improvement loop; fixed the manual-rollback actor race and canary suite
      isolation; STATUS note replaced with evidence
- [x] Smoke §17, Playwright runtime-hardening spec, ADR-024/ADR-025, `openspec validate harden-runtime`

### Phase 2b — web console (2026-10-29)

- [x] `apps/web` shell: sidebar (top-level + per-factory nav), factory switcher, account/usage footer;
      primitives (`Card`, `Badge`, `Table`, `EmptyState`, `Spinner`, `ComingSoon`)
- [x] New Chat → `POST /chat`, one `EventStream` renderer + `useRunStream` (replay by `Last-Event-ID`,
      gap detection, terminal close, auto-scroll only when pinned); inline permission prompts
- [x] Inbox (pending permissions + failed runs, deep links), Runs list (factory/status filters) and
      run detail (pinned commit, harness/model, steps, artifacts, live tail, cancel)
- [x] Dashboard: run counts, status split, spend (from `/runs`), honest empty state
- [x] Factory pages (read-only projections, no writes): Definition (resource tree by kind, resolved
      gates, version commit/tag/content hash/dirty, semantic diff with from/to selector), Gates
      (per-stage gate + source + merge policy, autonomy warning + benchmark-gate requirement),
      Agents (role, harness/model, runner, tool allow/deny, secret names, `spawnableBy`),
      Automations (triggers, agent, gate overrides), Scorers (labels, passingScore, samplingRate,
      judge model), Benchmarks (suites, configurations, pinned tasks), Self-improvement (threshold,
      reviewer type, benchmark win, opting-in scorers), Settings (manifest, repos, agent defaults)
- [x] `/factories/:name/resources` now also projects the normalised `doc` per resource (read-only,
      secret names only) so Agents/Automations/Scorers/Benchmarks render without a second route
- [x] Phase stubs name their phase: MCPs & apps (Phase 3), Secrets and Users (Phase 6)
- [x] Playwright: `chat`, `inbox`, `nav`, `runs`, `definition` (gates table, version, diff, autonomy
      warning); stubs asserted to name a phase; no CSS-class selectors, no console errors
- [x] `scripts/e2e.sh` (compose up → smoke → Playwright) + `.github/workflows/ci.yml`
      (`unit` = `bun install` + `bun run ci`, Docker-free; `e2e` = compose up + smoke + chromium)

### Phase 3a — factory loop (2026-10-29)

- [x] `packages/forge` (new): `CodeForge` (`checkout|createBranch|commit|openPullRequest|comment|getChecks|merge`),
      in-memory `FakeForge` (deterministic red checks via `[red]` marker / `simulateChecks`,
      `protected_branch` on writes to the default branch, idempotent PR creation, content-hash SHAs),
      shared contract suite (`@factory/forge/contract`) used by the fake backend (GitHub in 3b)
- [x] `packages/core`: `WorkItem` type + Zod schema + ULID ids; `003_work_items.sql`
      (`work_items`, `work_item_events`, `gate_decisions`, `autonomy_state`); Bun-SQL repository
      (create/transition/attach PR/list/events/gates/autonomy, retry-idempotent)
- [x] `packages/core`: stage graph compiler (`stages:` in `factory.yaml` or derived from agent roles;
      ordered `needs` edges; review fan-out; unknown stage/needs/cycle → `invalid_stage_graph` naming
      the node), per-stage config resolution with `spawnableBy` (`spawn_not_allowed`), loop gate
      aliasing onto the six-stage policy, autonomy policy (`autonomy_refused` while
      `benchmarkGateRequired` and no override)
- [x] `packages/orchestration`: `FactoryWorkflow` (one per work item, `continueAsNew` after N stages,
      entry judgement call, deterministic foreman dispatch, implement → PR, verify → checks, ship →
      merge policy) and child `StageWorkflow` (`run|review|gate` phases). Gate waits are Temporal
      **Updates** (`submitGateDecision`) + **Signal** fallback + `condition()` + SLA timer (ADR-013);
      no activity slot is held while waiting. Review fans out to ≥2 independent reviewer children and
      a judge returns `{verdict, findings[], confidence}` — advisory only, never an approval or merge.
      Kill switch (`autonomyPaused` signal + `autonomy_state` read before dispatch) cancels the
      in-flight stage child and ends `blocked`. `request_changes` moves back one stage with feedback,
      increments the loop count and escalates past the limit.
- [x] `apps/api`: `POST /work-items`, `GET /work-items` (factory/stage/status filters),
      `GET /work-items/:id` (item + events + gates), `POST /work-items/:id/gates/:stage` (records the
      decision, then delivers the Update), `POST /autonomy` (enable/pause with actor + reason; refuses
      lights-off without a benchmark-gate override; pause signals running work items)
- [x] Tests: forge contract suite, stage graph (default/fan-out/cycle/unknown), `spawnableBy`,
      autonomy policy, work-item schema, judge disagreement/incomplete; integration (Temporal + PG,
      fake forge + fake harness): full loop triage→spec→implement→review(2)→verify→ship,
      `request_changes` loop limit, SLA auto-reject and auto-approve, kill switch, disagreement →
      `needs_human`; API integration: create/list/detail, gate delivery, autonomy refusal/override,
      `invalid_stage_graph`, `spawn_not_allowed`
- [x] `apps/web` — Work items board (`/work-items`): seven stage columns (triage → ship), manual
      creation (`POST /work-items` through a same-origin proxy), factory filter, cards with
      id/title/source/age/status/loop count, derived links to each stage run and the detail page,
      pending-gate badge with SLA countdown, PR link, honest empty/error states
- [x] `apps/web` — Inbox gate approvals: pending gates across factories show stage, item, age, live
      SLA countdown and `approve | reject | request_changes` (feedback required for request_changes),
      posted to `POST /work-items/:id/gates/:stage`; the row leaves the inbox once decided
- [x] `apps/web` — Work item detail (`/work-items/:id`): stage timeline (from → to, by, reason),
      gate decisions (actor/time/automatic), reviewer findings per reviewer + judge verdict/confidence
      (advisory), PR link, forge checks, loop count, status events (merge evidence) and the item's
      last autonomy event; honest empty states for every projection the API does not have yet
- [x] `apps/web` — Gates page: live autonomy policy from `GET /factories/:name` plus the last
      `autonomy.*` event in the work-item log (no `GET /autonomy` read endpoint exists yet — the
      page says so); kill switch (`POST /autonomy`), and "Enable autonomy" disabled with an
      explanation while `benchmarkGateRequired` is unresolved, unless an override `{actor, reason}`
      is confirmed in a dialog
- [x] Playwright: `factory-loop` (manual item → triage/spec gates → implement → 2 reviewers + judge →
      verify → ship; asserts timeline, advisory verdict, PR link, checks, and that nothing merged
      before the ship gate) and `lights-off` (benchmark-gate refusal, override dialog, enable, all
      gates auto-resolve, merge on ship); every created work item/run cleaned up in `afterEach`
- [x] `scripts/smoke.sh` §11: one-stage factory loop on the fake stack (create work item → triage
      gate → approve → assert `stage.changed` triage→spec + `gate.decided` + Update delivery, then
      reject the next gate so no workflow is left parked)

## Phase 3a verification (2026-10-29)

```
bun run ci                     → typecheck clean; 221 pass / 24 skip / 0 fail; both factories validate,
                                 export --check canonical (15 files each)
docker compose up -d --build   → postgres, temporal, api, web, worker healthy
bash scripts/smoke.sh          → SMOKE PASSED incl. scripts/smoke-permissions.sh and §11 one-stage
                                 loop (create work item → triage gate → approve → stage.changed
                                 triage→spec + gate.decided delivered as an Update)
cd apps/web && bunx playwright test → 16 passed (14 existing + factory-loop + lights-off)
integration (Temporal + PG)    → factory-loop: 6 pass (full loop with 2 reviewers + merge,
                                 request_changes loop limit, SLA auto-reject, SLA auto-approve,
                                 kill switch, disagreement → needs_human)
apps/api integration           → 7 pass (create/list/detail, gate delivery, autonomy refusal +
                                 override, pause, invalid_stage_graph, spawn_not_allowed)
live compose E2E (curl)        → POST /work-items → triage/spec gates via Update → ship gate →
                                 done, PR https://forge.local/acme/api-service/pull/1, 6 gate rows
                                 (3 human, 3 automatic), advisory review.verdict with 2 reviewers
```

Repro:
```
DATABASE_URL=postgres://factory:factory@localhost:5433/factory TEMPORAL_ADDRESS=localhost:7233 \
RUN_INTEGRATION=1 bun test packages/orchestration/test/factory-loop.integration.test.ts
DATABASE_URL=postgres://factory:factory@localhost:5433/factory TEMPORAL_ADDRESS=localhost:7233 \
RUN_INTEGRATION=1 bun test apps/api/test/work-items.integration.test.ts
docker compose up -d --build && bash scripts/smoke.sh
cd apps/web && bunx playwright test
```

Notes:
- Loop stages (`triage, spec, plan, implement, review, verify, ship`) are compiled from an optional
  `stages:` block in `factory.yaml`; when it is absent the graph is derived from agent `role`s (the
  example factory yields triage→spec→implement→review→verify→ship; `ship` is a forge/merge stage with
  no agent). A loop stage without its own gate inherits the nearest six-stage gate policy
  (triage→spec, verify→implement, ship→pr_review).
- Factory stage runs are unattended agents: the harness auto-allows tool permissions
  (`RunInput.autoAllowPermissions`), while chat runs keep the ADR-013 human wait unchanged.
- Review verdicts are advisory. A disagreement forces the human review gate; a human approval at the
  ship gate is the authority that allows the merge, never the verdict.
- The board always renders all seven columns; a factory with no agent for a stage (e.g. `plan` in the
  example factory) shows an honest empty column, because the backend compiles the graph from agents.
- There is no `GET /autonomy` read endpoint yet. The Gates page shows the declaration from
  `GET /factories/:name` and the newest `autonomy.*` event in the work-item log; after a kill-switch
  action it shows the state returned by `POST /autonomy` verbatim. A dedicated read model is deferred
  to 3b.
- Deferred to later phases: ADR-014/ADR-015 are recorded (7.4); the remaining deferrals are the
  GitHub forge backend + merge queue (3b), an autonomy read endpoint, a work-item cancel endpoint
  (E2E cleanup rejects a pending gate instead), and real models for judgement/review (deterministic
  models behind injectable hooks today).

## Phase 2b verification (2026-10-29)

```
bun run ci                     → typecheck clean; 158 pass / 6 skip / 0 fail; both factories validate,
                                 export --check canonical (15 files each)
docker compose up -d --build   → postgres, temporal, api, web, worker healthy
bash scripts/smoke.sh          → SMOKE PASSED (14 SSE events, 1 terminal, permission approved,
                                 replay from seq 3 → 4, proxy stub + allowlist + revocation)
cd apps/web && bunx playwright test → 14 passed (chat, inbox, nav, runs, definition + gates)
```

Implementation notes:
- The console reads `apps/api` only (ADR-012): server components fetch the API; browser code talks to
  same-origin `/api/*` route handlers. No DB, filesystem, harness or runner import in `apps/web`.
- The Definition page defaults its diff `to` to the factory's pinned version commit (not `HEAD`), so a
  later commit that does not touch the factory directory cannot make the comparison look unrelated.
- With a single recorded version the diff card states that explicitly (`definition-diff-single-version`)
  instead of inventing changes; Phase 4/5 pages show declared configuration plus a "runs in Phase N" note.
- `runs.spec.ts` asserts newest-first on the row's `data-started-at` rather than parsing run ids, because
  integration fixtures create runs whose ids do not embed a timestamp.

## Phase 2a verification (2026-10-28)

```
bun run ci                  → typecheck clean; 139 pass / 1 skip / 0 fail; factories validate + canonical
openspec validate …         → valid
docker compose up -d        → postgres, temporal, api, worker all healthy
bash scripts/smoke.sh       → PASSED (14 SSE events, 1 terminal, replay from seq 3 → 4,
                              proxy stub call + streaming + model_not_allowed + token_revoked,
                              runs/<runId>/events.jsonl 14 lines + patch.diff)
worker kill + restart       → run resumed, status ok, seq 1..14 unique (no dupes/gaps), 1 terminal
clean state (down -v, up)   → smoke PASSED again
```

Implementation notes:
- Cancellation is **cooperative**: `POST /runs/:id/cancel` writes `runs.cancel_requested_at`, the pump
  activity polls it and aborts the adapter. Temporal activity cancellation is deliberately not used —
  a graceful worker shutdown would otherwise turn a resumable run into a cancelled one.
- The `fake` harness leases an **ephemeral** runner (workspace only, no container, no network), so CI
  exercises the whole pipeline with zero credentials.
- Proxy attempts are recorded in `proxy_attempts` (model/status/latency only), not in the canonical
  event log — the eleven-type `FactoryEvent` union has no proxy event type.
- `POST /runs/:id/proxy-token` exists only when `EXPOSE_RUN_TOKEN=1` (dev/smoke); the worker-minted
  run token is never returned by the API.
- The real `opencode` path is wired end to end (lease → `opencode serve` in the container → adapter →
  proxy env) but is **not** exercised in CI: it needs the runner image build and model credentials.
  `@factory/runners` bans `OPENAI_*` from lease env, so the proxy URL + per-run token are passed
  through the harness command (documented in `packages/orchestration/README.md`); a first-class
  proxy-env channel in the runner protocol is a Phase 2b/3 follow-up.

## Phase 1 verification (2026-10-28)

```
bun run ci        → typecheck clean; 79 pass / 0 fail; both factories validate; export --check canonical
factory validate  → example: 14 resources; example-lights-off: 14 resources
factory diff      → 3 gate changes + /mergePolicy, exit 1
```

Notes from implementation: gate stages are the six from `ARCHITECTURE.md` §2; agent-level `gates` omitted
(resolver is 3-level); duplicate identity is case-insensitive `kind:name`; flat and directory resource forms
both accepted; `benchmarkGateRequired` is true exactly when `fullyAutonomous`; kill switch deferred to Phase 3.

## Key findings that shaped the design

- Reference UI nav confirmed; per-factory sub-nav (not global); `Self-improvement` carries an open-items badge.
- Warp's definition schema: path-is-identity, `model` xor `harness`, scorers = labels + passingScore + samplingRate, benchmarks pin commit SHA + definition version.
- Warp gaps we will close: true lights-off merge policy, local-first runners, outbound SSE event stream, per-agent tool allowlists, factory-version canary/rollback, judge calibration.
- Orchestration: Postgres state machine now, Temporal-shaped interfaces, migrate to Temporal Cloud when multi-tenant.
- Harness abstraction: canonical `FactoryEvent` union + `HarnessAdapter`; opencode native first, generic CLI second, ACP third.
- Reliability: ≥2 independent reviewers + judge; review verdicts advisory; agents never push to main.

## Next

Roadmap items 1–11 are implemented (see the sections above and `research/software-factory-ideas.md`).
The remaining roadmap candidate is long-running missions (item 12).

The next implementation workstream is **remote runners + runner observability**, planned in
`docs/REMOTE_RUNNERS_PLAN.md`. It will start on `feat/remote-runners` with `add-remote-runners` and
`add-runner-observability`; no branch or code has been created yet. Central Temporal schedules; remote
hosts run an outbound-mTLS agent with no Temporal/Postgres access. Linux is first, then Windows
(native/Windows containers), then macOS (native/Tart). Host CPU/RAM/disk metrics and alerts are part of
the observability change.

Phase 6c OIDC/IdP, Temporal Cloud and multi-tenant isolation remain blocked on external infrastructure/IdP
decisions. The live GitHub forge path still needs a PAT, repo and webhook secret.

## Open questions

- Orchestration: **decided** — Temporal dev server from day one (ADR-001 accepted).
- Chat-as-harness: **decided** — always adapter + runner (ADR-002 accepted).
- Lights-off scope: **decided** — full autonomous loop; capability in Phase 3, benchmark guardrail in Phase 4.
- Local sandbox on macOS: Docker vs `sandbox-exec` vs Lima for the default runner.
- GitHub App vs PAT for repo identity in Phase 3.
- Token budget: warn user at ~500k context.

## Testing conventions (locked 2026-10-28)

- Playwright E2E for every web UI flow (New Chat streaming, Inbox, gates, Runs, Definition diff, Benchmarks).
- `docker compose up` + `scripts/smoke.sh` for initial deployment tests (web + api + worker + postgres + Temporal dev).

