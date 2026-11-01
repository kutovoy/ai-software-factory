# Spec Delta

## ADDED Requirements

### Requirement: Retry as a new run

A failed or cancelled chat run SHALL be retryable by creating a new run, never by reusing its id.

#### Scenario: Eligible
- **WHEN** `POST /api/v1/runs/:id/retry` is called on an `error` or `cancelled` chat run
- **THEN** a new run starts with the same input (prompt, factory, harness, model, runner, repo)
- **AND** the new run has a new id, proxy token and runner lease
- **AND** the response returns the new run

#### Scenario: Lineage
- **WHEN** a retry is created
- **THEN** the new run records `retryOf: <old id>`
- **AND** the old run reports `retriedBy` when a child exists

#### Scenario: Not eligible
- **WHEN** the run is `running`, `ok`, or a factory stage run
- **THEN** the request is refused with `run_not_retryable` naming the reason

#### Scenario: Double submit
- **WHEN** the same run is retried twice within the dedupe window
- **THEN** the second call returns the existing retry rather than starting another

#### Scenario: Immutability
- **WHEN** a retry starts
- **THEN** the original run's status, events and terminal record are unchanged
