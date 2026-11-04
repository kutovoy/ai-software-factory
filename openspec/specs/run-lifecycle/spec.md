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

### Requirement: Retry as a new run

A failed or cancelled chat run SHALL be retryable by creating a new run, never by reusing its id.

#### Scenario: Eligible
- **WHEN** `POST /api/v1/factories/:factoryId/runs/:id/retry` is called on an `error` or `cancelled` chat run
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

### Requirement: Cancellation cleanup is atomic

A canceled run SHALL complete cleanup before the workflow exits, even when cancellation is
delivered during the post-run phase.

#### Scenario: Cancel after artifact collection
- **WHEN** cancellation arrives after `collectArtifacts`
- **THEN** terminal event append, terminal-state read, finish, proxy revocation and runner
  kill run in one non-cancellable scope
- **AND** the run does not remain `running`

#### Scenario: Cleanup step failure
- **WHEN** finish or proxy revocation fails
- **THEN** the runner kill is still attempted
- **AND** the failure is recorded as a cleanup step

### Requirement: Orphaned runs are reconciled

A run marked `running` whose workflow is closed or missing SHALL be reconciled by the reaper.

#### Scenario: Reaped run
- **WHEN** the reaper removes a container for a `running` run
- **THEN** the run becomes `error`
- **AND** its error starts with `runner_orphaned:`
- **AND** a `runner-reaper` step records the reason

### Requirement: Budget enforcement

The run lifecycle SHALL enforce spend caps and record an actionable terminal error.

#### Scenario: Exceeded
- **WHEN** a run crosses `maxCostUsd`
- **THEN** the event pump stops the run with `budget_exhausted`
- **AND** the run ends `error` with that code in the failure message

#### Scenario: No cap
- **WHEN** no budget is configured
- **THEN** the run behaves exactly as before

### Requirement: Budget observability

The API SHALL expose configured caps and current spend for a factory.

#### Scenario: Read
- **WHEN** the budget endpoint is requested
- **THEN** it returns `maxCostUsdPerRun`, `maxCostUsdPerStage`, `maxCostUsdPerFactory`,
  `spentUsd` and `exhausted`

### Requirement: Policy-governed permissions

Unattended factory runs SHALL evaluate every permission request against the governance
policy before allowing it.

#### Scenario: Allow
- **WHEN** the policy allows the action
- **THEN** the permission is auto-allowed as before

#### Scenario: Deny
- **WHEN** the policy denies or requires a human
- **THEN** the permission is denied
- **AND** a `policy` step records `{action, decision, reason}`

#### Scenario: Chat
- **WHEN** a chat run requests a permission
- **THEN** the existing human durable wait is unchanged
