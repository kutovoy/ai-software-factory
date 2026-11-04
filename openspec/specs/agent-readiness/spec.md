# agent-readiness Specification

## Purpose
Defines a deterministic readiness score for a repository and a factory definition, and how
that score may gate autonomy.

## Requirements

### Requirement: Deterministic score

The system SHALL compute a readiness score from observable files and definition fields.

#### Scenario: Score
- **WHEN** readiness is requested for a factory
- **THEN** the report contains an overall score from 0 to 100
- **AND** it contains repository and factory sections with per-check `id`, `label`, `passed`, `weight`, `evidence` and `remediation`
- **AND** every check is derived from files or definition fields, never from a model call

#### Scenario: Status thresholds
- **WHEN** the score is at least the configured `ready` threshold
- **THEN** status is `ready`
- **WHEN** the score is at least the configured `warn` threshold but below `ready`
- **THEN** status is `warn`
- **WHEN** the score is below `warn`
- **THEN** status is `not_ready`

### Requirement: Repository checks

The repository section SHALL cover the signals an agent needs to change and verify code.

#### Scenario: Checks
- **WHEN** a repository is scanned
- **THEN** it checks style, build, tests, typecheck, documentation, dev environment, observability, security and task discovery
- **AND** each missing check carries a remediation hint

#### Scenario: Evidence
- **WHEN** a check passes
- **THEN** the evidence names the file, script or configuration that satisfied it
- **AND** a check that cannot be determined is reported as failed, not guessed as passing

### Requirement: Factory checks

The factory section SHALL cover the definition's own readiness for autonomy.

#### Scenario: Checks
- **WHEN** a factory definition is scanned
- **THEN** it checks for a QA agent, at least two reviewers, resolved gates, merge policy, required agent verdicts, scorers/benchmarks, secrets and MCP declarations
- **AND** each check reports evidence from the loaded definition

### Requirement: Autonomy gate

Readiness SHALL be advisory by default and MAY block autonomy when configured.

#### Scenario: Advisory
- **WHEN** `readiness.enforceAutonomy` is absent or false
- **THEN** the report is shown but autonomy is not refused

#### Scenario: Enforced
- **WHEN** `readiness.enforceAutonomy` is true and status is `not_ready`
- **THEN** enabling autonomy is refused with `readiness_not_ready`
- **AND** an explicit override `{actor, reason}` may still proceed

### Requirement: API and console

The readiness report SHALL be available through the nested factory API and the console.

#### Scenario: API
- **WHEN** `GET /api/v1/factories/{factoryId}/readiness` is called
- **THEN** the response includes the score, status, sections, checks and the scanned root

#### Scenario: Console
- **WHEN** the readiness page is opened
- **THEN** it shows the score, status, failing checks and remediation
- **AND** the dashboard shows a compact readiness card linking to the page
