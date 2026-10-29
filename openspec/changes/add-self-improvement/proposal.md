# Proposal

## Why

The factory can measure itself but cannot yet improve itself. Phase 5 closes the loop: observer agents read
scored runs, propose edits to the definition, probe them against the same work, and either open a PR, merge on
a benchmark win, or roll out as a canary — depending on a **per-factory authority setting** the user can
change at any time.

## What Changes

- Add `improvement.authority` to `factory.yaml`: `propose_only | auto_merge_on_benchmark | canary`.
- Add `packages/evals/improve`: observer agents, invariant/domain proposals, contrastive probe, compose,
  experience library (per factory + opt-in promotion), dedupe/impact ranking.
- Add `ImprovementWorkflow` (scheduled/on-demand) and `CanaryWorkflow` (rollout + rollback).
- Add `migrations/007_improvement.sql`: `proposals`, `proposal_edits`, `probes`, `lessons`, `canary_rollouts`,
  `improvement_runs`.
- Enforce blast radius: edits may touch agent prompts, skills, model routing, scorer rubrics and automation
  triggers — never `gates`, `mergePolicy`, or the factory's own source code.
- Add API + UI: ranked proposals with diff/evidence, authority selector (writes a definition change), lessons
  library with promote-to-shared, canary status and rollback.

## Capabilities

### New Capabilities
- `self-improvement`: evidence-driven definition changes with configurable authority, canary rollout and
  rollback.

### Modified Capabilities
- `factory-definition`: `improvement.authority` is added to the manifest (delta spec).

## Impact

- New workflow(s), tables, routes, and a real Self-improvement page.
- Depends on `measurement` (scores/calibration) and `benchmarks` (attestation/non-regression).
- Authority changes are definition changes: they go through git and are audited.
