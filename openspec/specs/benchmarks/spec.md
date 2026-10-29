# benchmarks Specification

## Purpose
Defines replayable benchmarks: running a task set across configurations at pinned revisions, aggregating
scores, comparing cost versus quality, and attesting a factory version for autonomy.

## Requirements

### Requirement: Suite loading and configuration matrix

Benchmark suites and tasks SHALL be loaded from the factory definition and SHALL form a (task × configuration)
matrix.

#### Scenario: Load
- **WHEN** a suite declares `agent`, `configurations` and `tasks`
- **THEN** every task file is used exactly once
- **AND** a task without full 40-character `startingRepoRefs` fails validation with `invalid_sha`

#### Scenario: Configuration hash
- **WHEN** a benchmark run is created
- **THEN** it records a `configHash` over the normalized matrix + `definitionCommit`
- **AND** changing any configuration produces a different hash

#### Scenario: Too many configurations
- **WHEN** a suite declares more than the supported maximum
- **THEN** validation fails with `too_many_configurations`

### Requirement: Cost estimate and cap

A benchmark SHALL estimate cost before execution, require confirmation above a threshold, and abort when a
hard cap is exceeded.

#### Scenario: Estimate
- **WHEN** a benchmark run is requested without `confirm: true` and the estimate exceeds the threshold
- **THEN** the API returns `cost_confirmation_required` with the estimate
- **AND** no trials start

#### Scenario: Cap
- **WHEN** cumulative cost reaches `maxCostUsd`
- **THEN** remaining trials are skipped with `budget_exhausted`
- **AND** the run completes with partial results marked as such

### Requirement: Hermetic replay

Each trial SHALL run at the task's pinned commit in a fresh sandbox and fresh forge repository, with the
factory definition pinned.

#### Scenario: Trial inputs
- **WHEN** a trial starts
- **THEN** it checks out `startingRepoRefs` at the full SHA
- **AND** it pins `definitionCommit` and `configHash`
- **AND** it uses a fresh fake-forge repo

#### Scenario: Network denied
- **WHEN** a trial is executed in hermetic mode
- **THEN** network access is disabled by default
- **AND** a trial requiring network fails with `network_denied`

#### Scenario: Trial failure
- **WHEN** a trial errors
- **THEN** it is recorded as `error` and excluded from aggregation
- **AND** the benchmark run continues

### Requirement: Aggregation and Pareto comparison

Results SHALL aggregate scores per configuration and report a cost-versus-quality frontier.

#### Scenario: Aggregation
- **WHEN** all trials finish
- **THEN** each configuration reports `passRate`, `weightedScore`, `sampleSize`, `costUsd`, and `errors`
- **AND** a judge-scored benchmark without passing calibration is marked `uncalibrated`

#### Scenario: Frontier
- **WHEN** results are rendered
- **THEN** non-dominated configurations are reported as the Pareto frontier
- **AND** labels `highest_performance`, `most_efficient`, `lowest_cost` are assigned where applicable

#### Scenario: Dominance
- **WHEN** one configuration is at least as good on every axis and strictly better on one
- **THEN** it is reported as dominating and a single recommendation is produced

### Requirement: Attestation for autonomy

A passing benchmark SHALL produce an attestation that gates can consume to satisfy `benchmarkGateRequired`.

#### Scenario: Attest
- **WHEN** a benchmark passes with calibrated judges
- **THEN** an attestation records `factory`, `definitionCommit`, `suite`, `configHash`, `passRate`,
  `calibrationOk`, `passed`, `createdAt`

#### Scenario: Gate consumes attestation
- **WHEN** autonomy is enabled for a factory version
- **THEN** the gate requires an attestation whose `definitionCommit` and `configHash` match the running version
- **AND** refuses with `benchmark_attestation_missing` otherwise

#### Scenario: Stale attestation
- **WHEN** the definition commit or configuration hash changes
- **THEN** the previous attestation no longer satisfies the gate
