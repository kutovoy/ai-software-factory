# run-lifecycle Specification

## Purpose
Defines durable agent runs: creation, execution, cancellation, and restart-resume, each pinned to an
exact factory definition version.

## Requirements

### Requirement: Run creation pins a definition version

A run SHALL record the factory name, the definition commit, and the harness/model it will use at creation
time, and SHALL NOT change them afterwards.

#### Scenario: Version recorded
- **WHEN** a run is created for `factories/example` at commit `abc123`
- **THEN** the run record contains `factory: example`, `definitionCommit: abc123`, `harness`, `model`
- **AND** the run is rejected if the definition does not validate

#### Scenario: Unknown factory
- **WHEN** a run is requested for a factory that does not exist
- **THEN** the API returns 404 with code `factory_not_found`

### Requirement: Durable execution

A run SHALL execute as a Temporal workflow such that killing and restarting the worker does not lose or
duplicate the run.

#### Scenario: Worker restart
- **WHEN** the worker process is killed while a run is in progress and then restarted
- **THEN** the run continues from its last completed step
- **AND** no step is executed twice

#### Scenario: Activity failure
- **WHEN** a runner activity fails transiently
- **THEN** it is retried with backoff up to the configured limit
- **AND** the run fails with `status: error` and a recorded reason after the limit

### Requirement: Cancellation

A run SHALL be cancellable at any point, terminating the harness session and the runner sandbox.

#### Scenario: Cancel mid-run
- **WHEN** `POST /runs/:id/cancel` is called while tools are executing
- **THEN** the run reaches `status: cancelled`
- **AND** the runner container is stopped
- **AND** a `run.completed` event with `status: cancelled` is appended

### Requirement: Terminal state

Every run SHALL end in exactly one terminal state (`ok`, `error`, `cancelled`) and SHALL emit exactly one
terminal event.

#### Scenario: Single terminal event
- **WHEN** a run completes
- **THEN** exactly one `run.completed` event exists for that run
- **AND** no further events are appended afterwards

### Requirement: Cause-preserving failures

A failed run SHALL record the underlying cause, not only the Temporal wrapper.

#### Scenario: Activity failure
- **WHEN** an activity throws `RunnerError: docker_unavailable`
- **THEN** the run summary and error include the code and message
- **AND** the `workflow-error` step records the same text
- **AND** the wrapper `Activity task failed` alone is not sufficient

#### Scenario: Nested cause
- **WHEN** the error has a cause chain
- **THEN** the deepest message is included
- **AND** duplicate messages are collapsed

### Requirement: Failure panel

The run detail page SHALL explain a failure.

#### Scenario: Error run
- **WHEN** a run ends `error`
- **THEN** a panel shows the error text, the code when known, and each failed step
- **AND** it shows the workflow id and a link to the Temporal UI
- **AND** known codes carry a remediation hint

#### Scenario: Cancelled run
- **WHEN** a run ends `cancelled`
- **THEN** the panel shows the cancellation reason and actor

#### Scenario: Healthy run
- **WHEN** a run ends `ok`
- **THEN** no failure panel is rendered
