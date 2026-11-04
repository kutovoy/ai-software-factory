# Spec Delta

## ADDED Requirements

### Requirement: Trace-backed proposals

Self-improvement proposals SHALL be able to cite deterministic trace scores as evidence.

#### Scenario: Trace failure
- **WHEN** a trace scorer records a failing score for a run
- **THEN** the observer sees the failure signature and rationale like any other score
- **AND** the proposal evidence includes the source run and the trace rationale

#### Scenario: Promotion
- **WHEN** a trace-driven proposal is accepted
- **THEN** it uses the existing probe, benchmark, canary and merge-queue path
- **AND** no separate promotion mechanism is introduced
