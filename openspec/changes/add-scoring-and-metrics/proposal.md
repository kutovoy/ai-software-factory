# Proposal

## Why

The loop runs, but nothing measures it. Without measurement:
- autonomy stays blocked (`benchmarkGateRequired`), because there is no evidence it is safe;
- self-improvement (Phase 5) has no signal to improve against;
- cost/quality claims are vibes.

Phase 4a builds the scoring and metrics layer. 4b will add benchmark replay and version comparison.

## What Changes

- Add `packages/evals`: scorer registry, deterministic scorers, LLM-judge scorers with versioned rubrics,
  sampling/cadence/budget, and a calibration harness (golden set + judge-vs-human agreement).
- Add `migrations/004_scoring.sql`: `scorer_definitions`, `score_runs`, `scores`, `score_evidence`,
  `calibration_sets`, `calibration_results`.
- Add a `ScoringWorkflow` (scheduled + on-demand) that samples runs, executes scorers, records scores with
  judge model/version/prompt hash, and emits `score.completed` events.
- Add metrics: throughput, cost per PR (per stage), cycle time, autonomy (human touchpoints/PR), automation %,
  defect rate — exposed via API and rendered on the dashboard.
- Add UI: real Scorers page, score detail, calibration panel, and dashboard metrics.

## Capabilities

### New Capabilities
- `measurement`: scorer registry, scoring execution, calibration, and factory metrics.

### Modified Capabilities
<!-- none: scoring consumes runs/events, it does not change their contract -->

## Impact

- New package `packages/evals`; new workflow + activities.
- New API routes: `/scorers`, `/scores`, `/scores/:id`, `/calibration`, `/metrics`.
- New UI sections on Scorers and Dashboard.
- Enables Phase 4b (benchmarks) and unblocks Phase 5 (self-improvement).
