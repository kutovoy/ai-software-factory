# Spec Delta

## ADDED Requirements

### Requirement: Architecture and maintainability assertions

Validation contracts SHALL support `architecture` and `maintainability` tiers with thresholded evidence, and
medium/high-risk runnable goals SHALL include them.

#### Scenario: Missing evidence
- **WHEN** a required architecture or maintainability assertion has no evidence
- **THEN** the verify gate refuses approval

#### Scenario: Deterministic check
- **WHEN** the repository provides an architecture or maintainability script
- **THEN** the assertion runs that command and records the result and metrics

#### Scenario: Agent report
- **WHEN** no deterministic script exists
- **THEN** the validator produces a concrete report with the thresholds used
