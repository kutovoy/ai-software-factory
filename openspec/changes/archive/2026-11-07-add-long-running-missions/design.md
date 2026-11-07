# Design

## Context

The existing factory has a durable `FactoryWorkflow` per work item, a compiled stage graph, durable gates,
a review committee, verify-stage validation evidence, Temporal `continueAsNew`, remote runners, RustFS
artifacts, budgets/quotas and scoring. Missions should be an additive orchestration layer, not a second
stage engine.

External references:

- Factory Missions: orchestrator → workers → validators; validation contract before code; features grouped
  into milestones; fresh agents; externalized state. See https://factory.com/news/missions-architecture.
- Factory planning guidance: 1–500 features, milestone validation, QA scripting, cost ≈ features + 2 ×
  milestones. See https://docs.factory.com/missions/planning.
- Mastra durable agents: the durable record is the source of truth; execution state and memory are separate;
  checkpoints should be small and large artifacts referenced. See
  https://mastra.ai/blog/what-are-durable-ai-agents.
- Temporal: multi-day waits are durable; use child workflows and `continueAsNew` to bound history. See
  https://docs.temporal.io/design-patterns/continue-as-new.
- Anthropic context engineering: context rot; compaction, structured note-taking and sub-agents. See
  https://www.anthropic.com/research/effective-context-engineering-for-ai-agents.

## Goals / Non-Goals

**Goals:**
- A durable mission model and workflow above work items.
- Plan approval, milestones, features, dependencies, checkpoints, validation and budget.
- Fresh context per feature and fresh validators at milestones.
- Reuse existing work items, stage graph, gates, review/verify, forge, merge, scoring and runners.
- Factory-scoped API and Mission Control UI.

**Non-Goals:**
- Parallel feature execution in the MVP (Factory lists parallelization as an open question).
- Cross-repo missions, mission templates or mission-level canary in the MVP.
- Replacing the existing stage engine or review committee.
- Multi-tenant mission isolation (follows Phase 6c).
- Letting validators implement fixes; validators only surface findings.

## Decisions

1. **Mission is a parent workflow; feature = work item.**
   `MissionWorkflow` starts a child `FactoryWorkflow` per feature. A feature work item starts at `implement`
   because the mission plan already contains the feature spec and acceptance assertions. This reuses PRs,
   review, verify, merge and scoring.

2. **Sequential features in the MVP.**
   Dependencies are persisted and validated, but the scheduler runs one feature at a time. Parallel features
   and git worktrees are a later phase.

3. **Validation contract before features.**
   The planner writes a mission validation contract first, then features that claim assertions. A human
   approves the plan by default; auto-approval is allowed only for `autonomyLevel: full` with the benchmark
   gate satisfied.

4. **Fresh context per feature.**
   A feature prompt is built from the mission goal, relevant assertions, feature spec/dependencies, shared
   state (completed work, decisions, failed approaches, test results, blockers), repo conventions and links.
   The full mission history is never replayed.

5. **Durable state outside the model.**
   DB rows are the source of truth. `mission_checkpoints` store small JSON state; `mission_events` is the
   audit log. After checkpoints, a human-readable `state.md` and `validation-contract.md` may be written to
   RustFS. Temporal history carries only mission id and indices.

6. **Fresh validators at milestone boundaries.**
   Scrutiny validator: code/tests/lint/typecheck/build and diff review. User-testing validator: start the app
   and exercise it with Playwright/agent-browser against the contract. Validators are separate from the
   implementer and never fix code. The orchestrator creates fix features from actionable findings.

7. **Bounded Temporal history.**
   `MissionWorkflow` uses child workflows and `continueAsNew` at milestone boundaries or when
   `workflowInfo().continueAsNewSuggested` is true. It never continues while a child is running. Signals are
   drained before continuing.

8. **Mission budget.**
   Optional `maxCostUsd`, `maxRuns` and `maxWallClockHours`; factory budget/quotas still apply. Admission
   refuses a feature or validation run with `mission_budget_exhausted` and the mission becomes `blocked`.

9. **Plan approval and intervention.**
   Plan gate uses a mission gate row and Temporal Update/Signal, mirroring stage gates. Pause/resume/cancel
   are signals plus read-model checks before dispatch. A blocked feature/validation hands control back to a
   human with a precise blocker.

## Risks / Trade-offs

- **Cost:** missions can spend quickly → mission budget, max features, max validation rounds, plan approval.
- **Merge conflicts:** sequential MVP and feature branches from the integrated head; block and create a fix.
- **Validation flakiness:** retry validation, distinguish infrastructure errors, preserve evidence, cap rounds.
- **Context drift:** fresh context packs and checkpoints; no full-history replay.
- **History growth:** child workflows and continue-as-new at milestone boundaries.
- **Plan quality:** schema validation, human approval and request-changes loop; readiness gate for QA.
- **Work-item creation duplication:** extract a shared creation path so API and mission worker use one builder.

## Migration Plan

- Add `024_missions.sql` with missions, milestones, features, checkpoints, events, gates, validations,
  mission links on work items/runs, indexes, and the `mission` work-item source.
- Existing work items/runs keep `mission_id = null`; no backfill.
- Factory purge deletes missions and children with the factory; mission links on work items/runs are
  `on delete set null` or cascade as appropriate.

## Open Questions

- Should mission features start at `spec` instead of `implement` for some factories? MVP starts at
  `implement`; make this configurable later.
- How much of the mission state should be materialized to RustFS vs only DB? MVP DB + optional artifacts.
- Should mission plan approval be skippable for `autonomyLevel: full`? Yes, behind the benchmark gate.
- When should parallel features be enabled? After the sequential MVP is proven.
