# Project status

Last updated: 2026-10-28

## Phase

**Phase 0 — Research & foundation: complete.** Architecture + roadmap drafted, awaiting user approval to
start Phase 1 (definitions as code).

## Done

- [x] `git init`, first commit `4d6da0d` (scaffold)
- [x] `openspec init --tools opencode --profile core` (schema: spec-driven)
- [x] `initial_idea.md` (brief + clarifications + "web chat is the harness" addendum)
- [x] `AGENTS.md`, `docs/GLOSSARY.md`, `docs/DECISIONS.md` (6 ADRs, status proposed)
- [x] `docs/ARCHITECTURE.md` (v0.1) and `docs/ROADMAP.md` (phases 1–6)
- [x] Research: `research/warp-factories.md` (446 lines), `research/ecosystem.md` (749), `research/talks.md` (18 talks)
- [x] `tools/yt/` YouTube toolkit (fetch/frames/scene/bundle) + `research/videos/x-PK3yx_MJg/` (transcript, 131 frames, ANALYSIS.md)

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

