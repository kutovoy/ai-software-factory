# Proposal

## Why

Scoring tells us how one run did. Benchmarks answer the question autonomy depends on: *is this factory
version, with this model/harness mix, better than the alternative on our own work?* Without replay at a
pinned state, benchmark numbers are not comparable, and `benchmarkGateRequired` can never be satisfied.

## What Changes

- Add benchmark execution to `packages/evals`: suite/task loading, configuration matrix, hermetic replay,
  scoring, aggregation, Pareto frontier and a recommendation.
- Add `BenchmarkWorkflow` (Temporal) fanning out child runs per (task × configuration), with a cost estimate
  and a hard cap before execution.
- Add `migrations/005_benchmarks.sql`: `benchmark_runs`, `benchmark_trials`, `benchmark_results`,
  `benchmark_attestations`.
- Add attestations: a passing benchmark for a `definitionCommit` + `configHash` satisfies
  `benchmarkGateRequired`, unblocking autonomy.
- Add API + UI: suite list, run dialog with estimate, results matrix, Pareto scatter, recommendation.

## Capabilities

### New Capabilities
- `benchmarks`: replayable, comparable evaluation of factory configurations with attestation.

### Modified Capabilities
<!-- measurement unchanged: benchmarks consume scores -->

## Impact

- New workflow + activities; new tables; new routes; new UI page (replaces the Phase-4 stub).
- Cost: benchmarks are the most expensive operation in the system — guarded by estimates and caps.
- Enables Phase 5 (self-improvement) to prove a proposal beats the baseline.
