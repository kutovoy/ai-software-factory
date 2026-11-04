# Spec Delta

## ADDED Requirements

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
