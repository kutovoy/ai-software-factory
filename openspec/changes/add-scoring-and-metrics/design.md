# Design

## Context

Runs already emit a canonical event stream and persist steps/artifacts. Scorers exist in the definition
(`labels[{value,score}]`, `passingScore`, `samplingRate`, judge model). Phase 4a turns those declarations
into actual graded records, with enough provenance that a score can be trusted and re-derived.

## Goals / Non-Goals

**Goals:**
- Scores that are comparable across time: judge model + version + prompt hash + rubric version recorded.
- Cheap by default: deterministic checks first, LLM judges sampled, hard budget cap.
- Calibration before trust: judge-vs-human agreement on a golden set, with a visible threshold.
- Metrics that are honest and cheap: no "savings vs human" estimates.

**Non-Goals:**
- No benchmark replay (4b).
- No self-improvement (Phase 5).
- No dashboards beyond the existing console.
- No defect-rate inference from code diffs; use forge events (reverts/incidents) when available.

## Decisions

1. **Two scorer classes.** `deterministic` (code: tests/build/lint/checks from artifacts) and `judge`
   (LLM with a rubric). Deterministic scorers are free and always run; judges are sampled.
2. **Rubric is content-addressed.** The scorer's markdown body + label set hash to a `rubricHash`; every
   score stores it, so re-scoring a frozen corpus with a changed rubric is detectable.
3. **Score = classification + score + evidence.** `{label, score, passing, evidenceRefs[], rationale}`.
   Evidence refs point at run events/artifacts, never blobs.
4. **Sampling + cadence + budget.** Per scorer: `samplingRate` (%), cadence (cron-ish), and a per-factory
   daily cap (`maxScoresPerDay`) to bound cost. Sampling is deterministic per run id (hash) so re-runs are
   stable.
5. **Calibration is a first-class table.** A golden set holds hand-labelled examples; a calibration run
   computes agreement (exact + within-tolerance), per-label confusion, and a pass/fail verdict. Scores from
   an uncalibrated judge are flagged `uncalibrated: true` and cannot satisfy the benchmark gate.
6. **Metrics are derived queries, not counters.** Compute from `runs`, `work_items`, `gate_decisions`,
   `scores` at read time; cache materialized views if slow. No event-sourced counters to drift.
7. **Scoring never blocks the loop.** It runs after terminal states, in its own workflow; failures mark the
   score `error`, never the run.

## Risks / Trade-offs

- **Judge cost drift.** Mitigation: daily cap + sampling + cheap default judge model; record tokens/cost per score.
- **Rubric gaming.** Mitigation: deterministic checks first, calibration set refreshed from human decisions,
  and score provenance exposed in the UI.
- **Metric ambiguity** (what counts as "human touchpoint"). Mitigation: define it as gate decisions +
  permission decisions + human comments on the PR; document in the API response.
- **Calibration sets are small.** Mitigation: report confidence intervals and refuse to certify below N.
