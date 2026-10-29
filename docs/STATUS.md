# Project status

Last updated: 2026-10-29

## Phase

**Phase 5a — self-improvement observer loop: complete** (2026-10-29). Factories now declare an
`improvement` authority in `factory.yaml` (`propose_only` default, `auto_merge_on_benchmark`, `canary`);
the observer turns a scored corpus into file-scoped edits, dedupes/ranks them, probes each against the
same work item, composes the winners into a validated candidate, and lands it by authority (PR for
`propose_only`, PR-or-merge on a calibrated benchmark attestation for `auto_merge_on_benchmark`).
Canary rollout/rollback is deferred to **Phase 5b**: the config validates and the apply path returns
`canary_not_available`, flagged `phase: "5b"` (ADR-020/ADR-021).
Next: **Phase 5b** (canary rollout + deterministic-hash routing) and **Phase 3b** (GitHub forge + merge
queue).

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
`POST /proposals/:id/apply` (`canary` → 409 `canary_not_available`, `phase: "5b"`), `GET /lessons`
(factory-scoped by default), `POST /lessons/:id/promote`, `POST /canary/rollback` (5b refusal).

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

1. Phase 3b: GitHub `CodeForge` backend (must pass the shared contract suite) + merge queue, and the
   MCPs & apps page (per-agent MCP wiring). Also: an autonomy read endpoint (`GET /autonomy`) and a
   work-item cancel route, so the console no longer derives state from the event log or cleans up
   by rejecting a gate.
2. Phase 5 self-improvement observer loop over scored runs, gated by a benchmark non-regression win
   (ADR-018 gives it a real attestation to compare against).
3. Rebuild tool for the read model (replay JSONL → Postgres) before benchmarks rely on it.
4. Real runner path: build `factory-runner:local`, verify `opencode serve` readiness + proxy env inside
   the container against a live model endpoint. Run a real (non-fake) benchmark once calibration and a
   model endpoint exist.

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

