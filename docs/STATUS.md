# Project status

Last updated: 2026-10-28

## Phase

**Phase 0 — Research & foundation.** No product code yet. Repo scaffolded, OpenSpec initialized,
research subagents running.

## Done

- [x] `git init` in `/Users/kutovoy/AI_tools/SoftwareFactory`
- [x] `openspec init --tools opencode --profile core` (schema: spec-driven, `.opencode/` skills + commands)
- [x] `initial_idea.md` captured (brief + clarifications + architecture addendum)
- [x] `AGENTS.md` written (workflow, layout, conventions, research rules)
- [x] Clarifying questions answered (scope, stack, gates, self-improvement scope, config format, UI depth)

## In flight (background subagents)

| Agent | Workstream | Output |
|---|---|---|
| A | YouTube research toolkit + analysis of `x-PK3yx_MJg` (Warp "What it takes to build a software factory") | `tools/yt/`, `research/videos/x-PK3yx_MJg/` |
| B | Warp Factories docs + blog deep dive | `research/warp-factories.md` |
| C | Gas Town/Gas City, Harness², OpenSpec, opencode/ACP, Temporal, competitors, talks | `research/ecosystem.md`, `research/talks.md` |

## Next

1. Review subagent outputs; extract the confirmed UI nav map and definition schema.
2. Write `docs/ARCHITECTURE.md` (system diagram, primitives, adapter interface, runner protocol).
3. Write `docs/DECISIONS.md` (ADR-001 orchestration engine, ADR-002 harness abstraction, ADR-003
   definition schema, ADR-004 gates model, ADR-005 self-improvement safety).
4. Present phased roadmap to the user for approval.
5. `openspec propose` the first vertical slice: "chat → run → events → inbox".

## Open questions

- Orchestration engine: Temporal vs lighter (Inngest/Restate/DBOS) for solo-on-Mac first.
- Whether the web chat *is* the harness (embedding opencode server) or proxies it via adapters.
- Sandboxing choice for local runners on macOS (Docker vs `sandbox-exec` vs microVM).
- How much of the self-improvement loop to build before benchmarks exist.
