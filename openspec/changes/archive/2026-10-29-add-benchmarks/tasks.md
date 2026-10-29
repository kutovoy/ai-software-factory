# Tasks

## 1. Evals (`packages/evals`)

- [x] 1.1 Suite/task loader + validation (`invalid_sha`, `too_many_configurations`, duplicate tasks)
- [x] 1.2 Configuration matrix + `configHash`
- [x] 1.3 Cost estimator (tasks × configs × median comparable run cost) + threshold
- [x] 1.4 Aggregation: passRate, weightedScore, sampleSize, costUsd, errors, `uncalibrated`
- [x] 1.5 Pareto frontier + labels + dominance recommendation
- [x] 1.6 Unit tests for hash stability, aggregation, frontier, dominance, caps

## 2. Persistence (`packages/core`)

- [x] 2.1 `005_benchmarks.sql`: `benchmark_runs`, `benchmark_trials`, `benchmark_results`, `benchmark_attestations`
- [x] 2.2 Repository: create run, record trial, aggregate, attestation lookup by `(factory, commit, configHash)`

## 3. Orchestration

- [x] 3.1 `BenchmarkWorkflow` — fan out trials with concurrency cap; partial failure tolerated
- [x] 3.2 Activities: `estimateCost`, `startTrial`, `aggregate`, `attest`
- [x] 3.3 Hard cap enforcement + `budget_exhausted`
- [x] 3.4 Emit `benchmark.started/completed` events (append-only, deduped)

## 4. API (`apps/api`)

- [x] 4.1 `GET /factories/:name/benchmarks` (suites + latest run)
- [x] 4.2 `POST /factories/:name/benchmarks/:suite/run` (estimate → confirm → start)
- [x] 4.3 `GET /benchmarks/:id` (matrix + frontier + recommendation)
- [x] 4.4 `GET /factories/:name/attestations`
- [x] 4.5 Gate integration: autonomy enable checks attestation (`benchmark_attestation_missing`)
- [x] 4.6 Tests: estimate, confirmation, cap, stale attestation

## 5. UI (`apps/web`)

- [x] 5.1 Benchmarks page: suites, last run summary, attestation badge
- [x] 5.2 Run dialog: configurations, tasks, estimate, confirm, cap
- [x] 5.3 Results: matrix table, Pareto scatter (pass rate vs cost), recommendation, per-trial drill-down
- [x] 5.4 Gates page: autonomy now shows attestation status and link

## 6. Tests & wrap-up

- [x] 6.1 Integration: run a 2-task × 2-config benchmark on fake harness/forge; assert matrix + frontier
- [x] 6.2 E2E: benchmark run → results → attestation → autonomy enable allowed
- [x] 6.3 Smoke: tiny benchmark (1 task × 2 configs) + attestation row
- [x] 6.4 STATUS, ADR-018 (attestation binds commit + config hash + calibration), ADR-019 (Pareto, not a score)
- [x] 6.5 `openspec validate add-benchmarks`
