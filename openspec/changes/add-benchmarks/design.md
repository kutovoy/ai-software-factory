# Design

## Context

Definitions already declare benchmark suites (`suite.yaml` + `tasks/*.yaml` with `startingRepoRefs` pinned to
full SHAs) and configurations (agent → model/harness). Scorers and calibration exist. What is missing is
execution, comparability and an attestation the gates can trust.

## Goals / Non-Goals

**Goals:**
- Replay the same task at the same commit across ≥2 configurations and compare fairly.
- Bound cost before spending it; never start an unbounded benchmark.
- Produce a recommendation a human can act on, and an attestation a gate can consume.
- Compare **factory versions**, not just models (the gap identified in the reference product).

**Non-Goals:**
- No recorded-tool-response replay (hermetic sandbox + fake forge is enough for v1; real replay is Phase 5+).
- No automatic promotion/rollout (Phase 5).
- No cross-factory benchmarking.

## Decisions

1. **One `BenchmarkWorkflow` per benchmark run**, fanning out child `RunWorkflow`s per (task × configuration),
   with a concurrency cap. Partial failures are recorded, not fatal — a trial that errors is excluded from
   aggregation and reported.
2. **Hermetic trials.** Each trial checks out `startingRepoRefs` (full SHA), pins `definitionCommit`, uses a
   fresh fake-forge repo and a fresh runner sandbox, and forbids network by default. A trial records the
   exact inputs so it can be re-run.
3. **Configurations are hashed.** `configHash` = hash of the normalized configuration matrix + definition
   commit. Attestations bind to it, so changing a config invalidates the attestation.
4. **Aggregate = per-task scores → per-config pass rate + cost.** Reuse the existing scorers (including the
   built-in correctness scorer from `successCriteria`). Judge scores must be calibrated or the benchmark is
   marked `uncalibrated` and cannot attest.
5. **Pareto, not a single winner.** Report the frontier of (pass rate, cost), and label `highest_performance`,
   `most_efficient`, `lowest_cost`. A single recommendation is derived only when one config dominates.
6. **Cost guard.** Estimate = tasks × configs × median cost of comparable runs; require explicit confirmation
   above a threshold; enforce a hard cap (`maxCostUsd`) that aborts remaining trials.
7. **Attestation.** `{factory, definitionCommit, suite, configHash, passRate, calibrationOk, passed,
   createdAt}`. Gates accept it only if `passed && calibrationOk` and the hashes match the running version.

## Risks / Trade-offs

- **Benchmarks are slow and expensive.** Mitigation: small task sets (5–10), concurrency cap, estimate +
  confirmation, abort on cap.
- **Replay side effects.** Mitigation: fresh forge repo + sandbox per trial; explicitly document that trials
  are not production replays.
- **Overfitting to the task set.** Mitigation: tasks sourced from real runs, rotate periodically, report
  sample size and confidence.
- **Judge drift invalidates history.** Mitigation: attestations bind `rubricHash` + judge model; a rubric
  change requires re-calibration and re-running the benchmark.
