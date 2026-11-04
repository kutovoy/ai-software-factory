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

### Requirement: Human interactions per PR

The metrics endpoint SHALL report human interactions per PR.

#### Scenario: Value
- **WHEN** PR work items have human gate and permission decisions
- **THEN** `humanInteractionsPerPr` is the count of those decisions divided by PRs opened in the window
- **AND** the definition and sample size are included

#### Scenario: No PRs
- **WHEN** no PRs were opened in the window
- **THEN** the value is `null` with a reason
- **AND** no zero is fabricated

### Requirement: Autonomy ratio

The metrics endpoint SHALL report the share of PR work items with no human touchpoint.

#### Scenario: Value
- **WHEN** PR items have gate and permission decisions
- **THEN** `autonomyRatio` is the percentage of those items with zero human touchpoints
- **AND** automatic gates do not count as human touchpoints

#### Scenario: Attribution
- **WHEN** a permission decision belongs to a stage run
- **THEN** it is attributed to the run's work item
- **AND** a permission that cannot be attributed is not silently assigned

### Requirement: Cost per accepted change

The metrics endpoint SHALL report cost per accepted change.

#### Scenario: Value
- **WHEN** PR work items reached `done`
- **THEN** `costPerAcceptedChange` is attributed run cost divided by accepted PR count
- **AND** only `done` PR items are included

### Requirement: Signal-to-production cycle time

The metrics endpoint SHALL report cycle time for non-manual work items.

#### Scenario: Value
- **WHEN** a non-manual PR item reached `done`
- **THEN** `signalToProductionCycleTime` averages creation to done
- **AND** manual items are excluded

### Requirement: Incident MTT

The metrics endpoint SHALL report mean time to resolution for incident items.

#### Scenario: Value
- **WHEN** incident work items reached `done`
- **THEN** `incidentMttHours` averages creation to done
- **AND** non-incident items are excluded

### Requirement: Merged-code age

The metrics endpoint SHALL report the average age of merged code in the window.

#### Scenario: Value
- **WHEN** PR items reached `done`
- **THEN** `mergedCodeAgeDays` averages the time from done to the window end
- **AND** the definition states that this is an age proxy, not a revert-based shelf-life measure

### Requirement: Trace evidence

The scoring context SHALL include deterministic trace evidence from the canonical event log
and the review gate verdict.

#### Scenario: Usage and messages
- **WHEN** a run emitted `usage.updated` and assistant `message.completed` events
- **THEN** the evidence records input/output/cache/reasoning tokens, cost, assistant message
  count, assistant character count and final-message characters

#### Scenario: File edits and scope
- **WHEN** a run emitted `file.edited` events or produced a patch
- **THEN** the evidence records changed paths, diff bytes, added/removed lines and patch bytes

#### Scenario: Review verdict
- **WHEN** the work item has a review gate verdict
- **THEN** the evidence records the verdict decision, finding count and summary length

### Requirement: Trace checks

Deterministic scorers SHALL support four trace checks: `redundant_tests`, `verbosity`,
`scope` and `review_usefulness`.

#### Scenario: Redundant tests
- **WHEN** the same test command is executed more than once
- **THEN** `redundant_tests` fails and cites the duplicate count

#### Scenario: Verbosity
- **WHEN** output tokens exceed 6,000 or assistant text exceeds 20,000 characters
- **THEN** `verbosity` fails

#### Scenario: Scope
- **WHEN** a run changes more than 20 files or produces a patch larger than 200,000 bytes
- **THEN** `scope` fails

#### Scenario: Review usefulness
- **WHEN** a review verdict has no findings or a summary shorter than 40 characters
- **THEN** `review_usefulness` fails
- **AND** a non-review run passes with an explicit `not a review run` rationale

### Requirement: Trace metrics on run detail

`GET /api/v1/factories/:factoryId/runs/:id` SHALL return deterministic trace metrics.

#### Scenario: Read
- **WHEN** a run detail is requested
- **THEN** the response includes tool calls, failed tool calls, tokens, cost, message volume,
  file edits, patch bytes, test counts, redundant tests and review usefulness
- **AND** the run page renders the four trace dimensions

### Requirement: Budget measurement

Factory metrics and run records SHALL expose spend against configured caps.

#### Scenario: Cost attribution
- **WHEN** a factory has a budget
- **THEN** recorded run cost remains attributable per stage
- **AND** the budget endpoint reports the same recorded spend used by the factory cap

#### Scenario: Exhausted work
- **WHEN** the factory cap is reached
- **THEN** new work is refused before a run is created
- **AND** no zero-cost run is fabricated
