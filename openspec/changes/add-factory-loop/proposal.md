# Proposal

## Why

Phase 2 proved a single run end-to-end. A factory is not a run — it is a *loop* over work items with
stages, an orchestrator (foreman), and human/agent gates. Phase 3a builds that loop against a **fake code
forge**, so it is fully testable without GitHub credentials, and so 3b (real GitHub + merge queue) only has
to implement a transport.

## What Changes

- Add `packages/forge`: a `CodeForge` interface (repo checkout, branch, commit, open PR, comment, merge,
  checks) with a `fake` backend used by tests and demos.
- Add work items as first-class records (typed, stable ids, lineage, source context) with a stage graph
  compiled from the factory definition.
- Add `FactoryWorkflow`: one durable workflow per work item; child workflows per stage; foreman dispatch
  with `spawnableBy` enforcement.
- Add gate decisions as durable workflow waits (reusing ADR-013): typed `approve|reject|request_changes`,
  SLA escalation timer, recorded in the event log, resolved through the existing gates resolver.
- Add a review committee: ≥2 independent reviewers + a judge; verdicts are advisory and returned to the
  foreman, never posted as approvals.
- Add lights-off capability: all stages agent-gated + merge policy + kill switch (guardrailed by the
  benchmark-gate flag until Phase 4).
- Add UI: a work-items board and gate approvals in the Inbox.

## Capabilities

### New Capabilities
- `factory-loop`: work items, stage graph, foreman dispatch, gates, review committee, autonomy and kill switch.

### Modified Capabilities
<!-- run-lifecycle unchanged: FactoryWorkflow composes it, it does not alter it -->

## Impact

- New package `packages/forge`; new workflows/activities in `packages/orchestration`.
- New API routes: work items, stage transitions, gate decisions, autonomy toggle.
- New UI: board + inbox approvals.
- No schema changes; gates/`mergePolicy` already exist in `factory.yaml`.
