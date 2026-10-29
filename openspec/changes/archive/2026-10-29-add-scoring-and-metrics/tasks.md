# Tasks

## 1. Evals package (`packages/evals`)

- [x] 1.1 Scorer registry loader from definition + `class` inference (`deterministic|judge`) + `rubricHash`
- [x] 1.2 Deterministic scorers: tests/build/lint from artifacts; `missing_artifact` handling
- [x] 1.3 Judge scorer: rubric → prompt, label parsing, `{label, score, passing, rationale}`, provenance
- [x] 1.4 Deterministic sampling (hash of runId), cadence, daily budget cap
- [x] 1.5 Calibration: golden set, agreement + per-label confusion + verdict, minimum size
- [x] 1.6 Unit tests for sampling determinism, budget, calibration math, rubric hash

## 2. Persistence (`packages/core`)

- [x] 2.1 `004_scoring.sql`: `scorer_definitions`, `score_runs`, `scores`, `score_evidence`, `calibration_sets`, `calibration_items`, `calibration_results`
- [x] 2.2 Repository functions: upsert scorer, record score, query by run/item/stage/factory, aggregate pass rate
- [x] 2.3 Metric queries (throughput, cost/PR per stage, cycle time, touchpoints, automation %, defect rate)

## 3. Orchestration

- [x] 3.1 `ScoringWorkflow` — scheduled + on-demand; samples eligible runs; runs deterministic then judges
- [x] 3.2 Activities: `runDeterministic`, `runJudge` (via adapter with a judge model), `persistScore`
- [x] 3.3 Emit `score.completed` events (append-only, deduped)
- [x] 3.4 Failure isolation: scorer failure never fails a run

## 4. API (`apps/api`)

- [x] 4.1 `GET /factories/:name/scorers` (registry + calibration status)
- [x] 4.2 `GET /scores?run=&workItem=&stage=&scorer=`, `GET /scores/:id`
- [x] 4.3 `POST /calibration` (start), `GET /calibration/:scorer`
- [x] 4.4 `GET /factories/:name/metrics?window=`
- [x] 4.5 Tests for aggregation, `null` + reason for missing data, budget exhaustion

## 5. UI (`apps/web`)

- [x] 5.1 Scorers page: registry table (class, labels, passingScore, sampling, judge, calibration badge)
- [x] 5.2 Score detail: label/score/rationale/evidence links/provenance/cost
- [x] 5.3 Calibration panel: agreement, confusion, verdict, insufficient-data state
- [x] 5.4 Dashboard: metrics cards with definition tooltips, per-stage cost breakdown, `null` states
- [x] 5.5 Run detail: scores attached to the run

## 6. Tests & wrap-up

- [x] 6.1 Integration: score a completed fake-harness run deterministically + judge (stub judge model)
- [x] 6.2 E2E: scorers page + score detail + dashboard metrics render with real data
- [x] 6.3 Smoke: score one run and assert a score row + `score.completed`
- [x] 6.4 STATUS, ADR-016 (score provenance + calibration gate), ADR-017 (metrics are derived queries)
- [x] 6.5 `openspec validate add-scoring-and-metrics`
