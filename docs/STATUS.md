# Project status

Last updated: 2026-10-28

## Phase

**Phase 2a — headless runtime: complete** (2026-10-28). Temporal runs, harness adapters, runner
protocol, API + SSE, inference proxy, compose + smoke. Next: Phase 2b (Next.js UI + Playwright).

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

1. Phase 2b: `apps/web` (Next.js) — New Chat streaming, Inbox approval, Runs detail, Definition diff;
   Playwright E2E asserting streamed events land in the DOM.
2. Phase 3: factory stages/foreman/gates as child workflows, `awaitGate` updates + escalation timers.
3. Rebuild tool for the read model (replay JSONL → Postgres) before benchmarks rely on it.
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

