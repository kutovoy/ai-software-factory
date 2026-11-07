# Proposal

## Why

The factory loop is excellent at one bounded work item: a stage graph, durable gates, review and verify,
and a merge policy. It is not a mission system. A multi-feature goal still requires a human to decompose
the goal, create work items one by one, sequence them, watch failures and decide when the project is done.

Research and external implementations converge on the same shape: a durable orchestrator plans a goal,
writes a validation contract before code, decomposes it into features grouped into milestones, dispatches
fresh workers, and validates each milestone with fresh validators. Context must live outside the model:
checkpoints and shared state are the durable record; the context window is not a persistence layer.

## What Changes

- Add a **mission** entity above work items: goal, pinned definition version, plan, milestones, features,
  checkpoints, events, gates, validations and budget.
- Add a durable `MissionWorkflow` that plans, waits for plan approval, runs feature work items sequentially,
  validates at milestone boundaries, creates fix features from findings, and pauses/blocks for humans.
- Reuse the existing `FactoryWorkflow` per feature. A mission feature is a work item starting at `implement`;
  triage/spec/plan are supplied by the mission plan.
- Add a mission-level validation contract with behavioral assertions, tool/evidence requirements and a
  fresh-validator loop (scrutiny + user-testing).
- Add mission checkpoints and a mission event log. Materialize human-readable state and contract artifacts
  in the artifact store; pass only IDs/keys through Temporal.
- Add factory-scoped mission API routes and a Mission Control UI: plan approval, progress, timeline,
  validation evidence, pause/resume/cancel/replan, budget.
- Add mission budget caps and admission checks; attribute feature and validation runs to the mission.
- Extend factory purge and ownership scoping to missions.

## Capabilities

### New Capabilities

- `missions`: mission lifecycle, plan, milestones, features, checkpoints, events, gates, validations and
  budget.

### Modified Capabilities

- `factory-loop`: mission feature work items start at `implement` and are linked to a mission.
- `http-api`: factory-scoped mission routes and OpenAPI parity.
- `web-console`: Mission Control list/detail, plan approval, timeline, validation evidence and controls.
- `validation-contract`: mission-level behavioral contract and evidence evaluation.
- `quotas`: mission spend/run/duration caps.
- `factory-purge`: missions and mission children are purged with the factory.
- `read-model`: mission projections for list/detail and pending plan gates.

## Impact

- New core module `packages/core/src/missions/*`, migration `024_missions.sql`.
- New orchestration workflow/activities/client and a mission planner boundary.
- New API module and OpenAPI entries.
- New web pages/components/nav/help entries.
- Tests: plan schema/scheduler, mission workflow with fake harness, API contract, Playwright Mission Control.
- Docs: ADR, STATUS, ROADMAP, HANDOVER, GLOSSARY, ARCHITECTURE, README "What's new".
