# AGENTS.md — Software Factory

This repo builds an open, model-agnostic, harness-agnostic **software factory**: a team of AI agents
running the SDLC loop (triage → spec → implement → review → verify → ship) behind a web UI, with
optional human checkpoints ("lights on" by default, "lights off" configurable), definitions stored as
versioned code, and a self-improvement loop gated by evals and benchmarks.

## Read this first

1. `initial_idea.md` — the founding brief + clarifications. Do not rewrite it; append.
2. `docs/STATUS.md` — current phase, what is done, what is next.
3. `docs/DECISIONS.md` — architecture decision records (ADR-lite). Add one entry per irreversible choice.
4. `research/` — grounded research: `warp-factories.md`, `ecosystem.md`, `talks.md`, `videos/`.
5. `openspec/specs/` — the living specification. `openspec/changes/` — in-flight work.

## Workflow: OpenSpec (mandatory)

Every non-trivial change goes through OpenSpec, not ad-hoc edits.

```bash
openspec list                 # active changes
openspec list --specs         # existing specs
openspec show <change>        # inspect a change
openspec validate <change>    # validate before implementing
openspec archive <change>     # after implementation + verification
```

- Propose: `/opsx-propose "<idea>"` (or `openspec change ...`) → proposal, design, spec deltas, tasks.
- Apply: `/opsx-apply-change` → implement tasks, tick them off in `tasks.md`.
- Archive only when tasks are done **and** the spec delta is verified against tests/behaviour.
- Specs describe observable behaviour and contracts, not implementation details.

## Repo layout (target)

```
apps/web            Next.js UI (chat = harness front-end, inbox, runs, factories, benchmarks)
apps/api            Orchestration API (sessions, runs, approvals, events/SSE)
packages/core       Domain model: factory definition schema, work items, stages, gates
packages/adapters   Harness adapters (opencode first, generic CLI second)
packages/runners    Runner protocol + local runner + remote runner client
packages/evals      Scorers, benchmarks, self-improvement loop
factories/          Example factories as code (factory.yaml + agents/ + automations/ + ...)
tools/yt            YouTube research toolkit (download, transcript, frames)
research/           Research notes and video bundles
openspec/           Specs and change proposals
docs/               STATUS, DECISIONS, ARCHITECTURE, GLOSSARY
```

## Conventions

- **Language:** TypeScript everywhere (Bun workspaces). Node 22+, ESM.
- **DB:** Postgres (Supabase-compatible); migrations in `packages/core/migrations`.
- **Config:** factory definitions are YAML/JSON in git; the DB only indexes them. Never let the UI
  become the source of truth for definitions — edits must round-trip to files + a commit.
- **Model access:** always via an OpenAI-compatible base URL + key from env. Never hardcode a vendor.
- **Harness access:** always via `packages/adapters` interface. Never call opencode/Claude/Codex APIs
  directly from UI or domain code.
- **Runners:** tool execution never happens in the web process. Everything runs through the runner
  protocol (local subprocess runner or remote worker).
- **Events:** every run emits an append-only event log (JSONL) — this is the audit trail and the raw
  material for scorers/self-improvement.
- **Secrets:** referenced by name in definitions, resolved at run time, never written to logs.
- **Versioned API:** every public HTTP endpoint lives under `/api/v1` (the liveness probe `/health` is the only
  unversioned route; `/api/v1/health` also exists). `apps/api/openapi.json` is the source of truth: any route
  added, changed or removed must update the spec in the same change, and the contract test fails when the route
  table and the spec diverge. Breaking changes bump the prefix; never silently change a v1 shape, unless an ADR
  records an explicit exception and every client moves in the same change.
- **Help stays current:** any feature, page or route change must update the matching help entry in
  `apps/web/src/lib/help.ts`, the menu reference, and the quick start when the first-run flow changes —
  in the same OpenSpec change. Help is part of the product, not an afterthought; `apps/web/src/lib/help.test.ts`
  fails when a nav item loses its entry, and `openspec validate` must list the help update in `tasks.md`.
- **README stays current:** any change to features, install steps, supported models/harnesses, architecture or
  licensing must update `README.md` in the same change. It is the public front door; keep its structure and
  claims accurate, and keep the Creator/attribution section intact.

## Delegation

- Prefer **2–3 subagents** for large workstreams instead of doing everything in the main agent. Split by layer
  (backend / console / docs) and run sequentially when they touch overlapping files; give each a self-contained
  prompt with file pointers, rules and a verification command. Keep the main agent for decisions, specs,
  verification and small edits — that is what keeps its context usable.

## Research rules

- `serper_search_web` is the primary search. `searxng` is fallback only.
- If serper output begins with `[SERPER FALLBACK ACTIVE...]` or `[SERPER EMPTY...]`, tell the user.
- For library/API docs prefer `context7`.
- Ground every design claim in a URL. Put research in `research/`, not in code comments.

## Context hygiene

- Delegate large research/build workstreams to subagents; have them write files and return ≤25-line
  summaries.
- Keep `docs/STATUS.md` current after every work session.
- Warn the user when the session approaches ~500k tokens.

## Testing

- **Unit/integration:** `bun test` (vitest-compatible) per package; schema + resolver + diff tests are mandatory.
- **Web UI:** Playwright E2E for every user-visible flow — New Chat streaming, Inbox approval, gate
  decision, Runs detail, Definition diff, benchmark compare. Use the `playwright` MCP tools for live
  inspection while developing, and a checked-in `e2e/` suite (Playwright test runner) in CI.
  Assert on streamed events landing in the DOM (tool call appears, diff renders, run reaches terminal state),
  not just on page load.
- **Deployment:** `docker compose up` must bring up the full stack (web + api + worker + postgres + temporal
  dev server) and pass a smoke test (`scripts/smoke.sh`: health endpoints, create a run, receive one SSE
  event, approve a gate). Keep a `compose.yaml` per environment (`dev`, `test`). If a component cannot be
  containerised yet, stub it explicitly and record why in `docs/STATUS.md`.
- **Performance:** after a major feature addition or a change to a hot read/write path, run
  `bun run perf:read-path` and add/refresh a focused performance test where the feature introduces a new
  fan-out, N+1 query, large list render, or background loop. Reasonable means measuring the affected
  surface (p50/p95 and call/query counts), comparing it with the baseline in `docs/PERFORMANCE.md`, and
  recording the result in `docs/STATUS.md` — not adding a heavyweight load test for every small edit.
  Prefer batch/projection tests over per-item detail fan-out, and assert constant call/query counts.
- **Agent-written tests:** a bug-fix test must fail against pre-patch code, or it proves nothing.

## Definition of done

- `openspec validate <change>` passes.
- Types compile (`bun run typecheck`), tests pass (`bun test`).
- Web UI flows covered by Playwright; `docker compose up` smoke test passes when the phase ships a service.
- Major feature or hot-path changes have a performance measurement and, where relevant, a focused test;
  `bun run perf:read-path` passes and the result is recorded in `docs/STATUS.md`.
- A factory definition in `factories/` round-trips: export → diff → import → identical.
- Status doc updated.
