# Project status

Last updated: 2026-10-28

## Phase

**Phase 1 — Definitions as code: complete** (`factory-v0` tagged). Next: Phase 2 (Temporal + opencode
adapter + local runner + chat/runs/inbox UI). Awaiting user go-ahead.

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

1. User approves architecture + roadmap (or requests changes).
2. `openspec propose` Phase 1: "factory definition schema + git round-trip".
3. Install a small set of vetted agent skills into `.opencode/skills/` (needs serper survey + license check).
4. Fill ADR statuses (accept/supersede) and add ADR-007 (event schema), ADR-008 (merge queue).

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

