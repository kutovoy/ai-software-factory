# Spec Delta

## ADDED Requirements

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
