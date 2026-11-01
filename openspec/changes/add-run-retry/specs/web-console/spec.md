# Spec Delta

## ADDED Requirements

### Requirement: Retry control

The run page SHALL offer retry where it is valid, and its failure copy SHALL match reality.

#### Scenario: Eligible run
- **WHEN** a chat run ends `error` or `cancelled`
- **THEN** the page shows "Retry as new run"
- **AND** activating it navigates to the new run
- **AND** it is disabled while the request is in flight

#### Scenario: Ineligible run
- **WHEN** the run is `ok`, `running`, or a factory stage run
- **THEN** no retry control is shown
- **AND** the page explains where retry belongs (the work item) for stage runs

#### Scenario: Truthful copy
- **WHEN** the failure panel advises next steps
- **THEN** it references the retry control that exists
- **AND** it does not promise an action the page cannot perform
