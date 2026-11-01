# Spec Delta

## ADDED Requirements

### Requirement: Contextual run actions

The run page SHALL only offer actions that apply to the run's state.

#### Scenario: Live run
- **WHEN** the run is `pending`, `running` or `cancelling`
- **THEN** "Cancel run" is shown and enabled

#### Scenario: Terminal run
- **WHEN** the run is `ok`, `error` or `cancelled`
- **THEN** no cancel control is rendered
- **AND** the terminal status is shown instead

#### Scenario: Stage run
- **WHEN** the run belongs to a factory stage
- **THEN** no per-run retry is offered
- **AND** the page links to the work item where retry lives

#### Scenario: Chat run
- **WHEN** a chat run failed or was cancelled
- **THEN** "Retry as new run" remains available
