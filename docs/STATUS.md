# Project status

Last updated: 2026-10-29

## Phase

**Phase 3a — factory loop: complete** (2026-10-29). Work items are durable workflows
(`FactoryWorkflow` + child `StageWorkflow`), the stage graph is compiled from the definition, the
foreman dispatches with `spawnableBy` enforcement, gates are workflow-level durable waits
(Update/Signal + SLA), the review committee is advisory (≥2 reviewers + judge), and autonomy has a
policy + kill switch — all exercised on the fake forge + fake harness. Phase 2b web console remains
complete.
Next: **Phase 3b** (GitHub forge + merge queue) and the Phase 3 UI (work-items board, gate approvals).

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

## Phase 3a verification (2026-10-29)

```
bun run ci                     → typecheck clean; 221 pass / 23 skip / 0 fail; both factories validate,
                                 export --check canonical (15 files each)
docker compose up -d --build   → postgres, temporal, api, web, worker healthy
bash scripts/smoke.sh          → SMOKE PASSED incl. scripts/smoke-permissions.sh
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
- Deferred to other tasks: ADR-014/ADR-015 (7.4), UI board/inbox (6.x), smoke one-stage loop (7.3),
  GitHub forge backend (3b), real model for judgement/review (deterministic models behind injectable
  hooks today).

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

1. Phase 3b: GitHub `CodeForge` backend (must pass the shared contract suite) + merge queue; then the
   Phase 3 UI (work-items board, gate approvals in the Inbox, live autonomy state + kill switch) and
   MCPs & apps page (per-agent MCP wiring).
2. Rebuild tool for the read model (replay JSONL → Postgres) before benchmarks rely on it.
3. Phase 4: scorers on real runs + benchmark replay; then Phase 5 self-improvement observer loop.
4. Real runner path: build `factory-runner:local`, verify `opencode serve` readiness + proxy env inside
   the container against a live model endpoint.

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

