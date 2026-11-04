# Spec Delta

## ADDED Requirements

### Requirement: Sandbox cleanup on cancellation and failure

The runner SHALL release its sandbox on every terminal path, including cancellation before
a lease handle is returned.

#### Scenario: Cancellation after artifact collection
- **WHEN** a run workflow is canceled after artifacts are collected
- **THEN** the run row reaches a terminal state
- **AND** `killRunner` removes the sandbox container
- **AND** the proxy token is revoked

#### Scenario: Cancellation during lease
- **WHEN** cancellation arrives while `leaseRunner` is building/starting/waiting for readiness
- **THEN** the activity heartbeats and observes the cancellation
- **AND** it removes the deterministic container name before failing
- **AND** no orphan container remains

#### Scenario: No lease handle
- **WHEN** cleanup runs after a lease failure or cancellation with no handle
- **THEN** `killRunner` derives `factory-<runId>` and attempts a best-effort kill
- **AND** an orphan-cleanup step is recorded

### Requirement: Orphan runner reaper

The worker SHALL periodically reconcile label-managed runner containers with the run read
model and Temporal.

#### Scenario: Terminal or missing run
- **WHEN** a `factory.run` container belongs to a terminal run or a missing run row
- **THEN** the container is removed
- **AND** its workspace is removed when it is in the managed root

#### Scenario: Closed or missing workflow
- **WHEN** a run row is `running` but its Temporal workflow is closed or missing
- **THEN** the container is removed after the configured grace period
- **AND** the run row is marked `error` with `runner_orphaned`

#### Scenario: Live run
- **WHEN** a run is `running` and its workflow is running
- **THEN** the container is kept

#### Scenario: Temporal unavailable
- **WHEN** Temporal cannot be reached
- **THEN** running containers are skipped
- **AND** terminal/missing-run containers may still be removed

#### Scenario: Dry run
- **WHEN** the reaper runs in dry-run mode
- **THEN** it reports would-remove actions
- **AND** removes nothing
