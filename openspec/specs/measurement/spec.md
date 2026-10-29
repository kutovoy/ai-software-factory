# measurement Specification

## Purpose
Defines how factory work is measured: scorer registry and execution, score provenance, judge calibration,
and the core factory metrics.

## Requirements

### Requirement: Scorer registry

Scorers SHALL be loaded from the factory definition, classified as `deterministic` or `judge`, and SHALL
carry a content-addressed rubric hash.

#### Scenario: Load
- **WHEN** a factory defines scorers
- **THEN** each scorer is registered with `name`, `class`, `labels`, `passingScore`, `samplingRate`,
  `judgeModel`, `selfImprovement`, and `rubricHash`
- **AND** an invalid scorer (no label meeting `passingScore`, or none below it) fails validation

#### Scenario: Rubric change
- **WHEN** a scorer's body or labels change
- **THEN** its `rubricHash` changes
- **AND** existing scores keep the hash they were produced with

### Requirement: Deterministic scorers

Deterministic scorers SHALL evaluate run artifacts without a model and SHALL always run.

#### Scenario: Checks pass
- **WHEN** a run's artifacts show tests, build and lint succeeded
- **THEN** the deterministic scorer records `passing: true` with evidence refs

#### Scenario: Missing artifact
- **WHEN** a required artifact is absent
- **THEN** the score is `error` with code `missing_artifact`
- **AND** the run itself is unaffected

### Requirement: LLM-judge scorers

Judge scorers SHALL grade a run against their rubric, sampled deterministically, and SHALL record full
provenance.

#### Scenario: Sample
- **WHEN** a scorer has `samplingRate: 25`
- **THEN** approximately 25% of eligible runs are scored
- **AND** selection is deterministic per `runId` so re-scoring selects the same runs

#### Scenario: Provenance
- **WHEN** a judge score is recorded
- **THEN** it stores `judgeModel`, `judgeModelVersion`, `rubricHash`, `promptHash`, token usage and cost
- **AND** `rationale` and `evidenceRefs` are stored

#### Scenario: Budget cap
- **WHEN** the factory's daily score cap is reached
- **THEN** further judge scoring is skipped with `budget_exhausted`
- **AND** deterministic scoring continues

### Requirement: Calibration

Judge scorers SHALL be calibratable against a human-labelled golden set, and uncalibrated judges SHALL be
flagged and SHALL NOT satisfy the benchmark gate.

#### Scenario: Agreement
- **WHEN** a calibration run completes on a set of at least the configured minimum size
- **THEN** it reports exact agreement, per-label confusion, and a pass/fail verdict against a threshold
- **AND** the result is stored with the rubric hash and judge model

#### Scenario: Uncalibrated judge
- **WHEN** a judge has no passing calibration for its current rubric hash
- **THEN** its scores are marked `uncalibrated: true`
- **AND** they cannot be used to satisfy `benchmarkGateRequired`

#### Scenario: Too small
- **WHEN** the golden set is below the minimum size
- **THEN** calibration returns `insufficient_data` instead of a verdict

### Requirement: Score records

Every score SHALL be queryable by run, work item, stage, scorer and factory, with its evidence and outcome.

#### Scenario: Query
- **WHEN** scores are requested for a run
- **THEN** each score returns `scorer`, `label`, `score`, `passing`, `rationale`, `evidenceRefs`,
  `uncalibrated`, and cost

#### Scenario: Aggregation
- **WHEN** scores are aggregated for a factory over a window
- **THEN** the API returns pass rate per scorer, weighted by `score`, with sample counts

### Requirement: Factory metrics

The system SHALL expose, for a factory and window: PR throughput, cost per PR (total and per stage), cycle
time (kickoff→merge), time to first human review, autonomy (human touchpoints per PR), automation %, and
defect rate where forge data exists.

#### Scenario: Metrics response
- **WHEN** metrics are requested
- **THEN** each metric returns `value`, `unit`, `sampleSize`, and `definition` (how it is computed)
- **AND** metrics with no data return `null` plus a reason, never zero

#### Scenario: Human touchpoints
- **WHEN** autonomy is computed
- **THEN** a human touchpoint counts gate decisions, permission decisions and human PR comments
- **AND** the definition is included in the response

#### Scenario: Cost attribution
- **WHEN** cost per PR is computed
- **THEN** it is attributable per stage (triage/spec/implement/review/verify/ship)
- **AND** unattributed cost is reported separately rather than hidden
