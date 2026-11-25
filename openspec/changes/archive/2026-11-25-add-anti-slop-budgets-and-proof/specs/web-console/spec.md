# Spec Delta

## ADDED Requirements

### Requirement: Review packet decision surface

Work-item detail and Inbox SHALL render the review packet as a decision surface: budget vs actual, blast
radius, proof artifacts, read-first list, decisions, reviewer roles and comprehension estimates.

#### Scenario: Proof gallery
- **WHEN** a packet has proof artifacts
- **THEN** the UI shows thumbnails/links bound to the run and commit
- **AND** a missing required proof is called out

#### Scenario: Read-first
- **WHEN** a packet has changed files
- **THEN** the UI shows the ordered files and why to read them first

### Requirement: Plan depth and visual artifacts

Mission Control SHALL show plan depth, expected pain, leverage and visual plan artifacts before approval.

#### Scenario: Plan gate
- **WHEN** a plan is awaiting approval
- **THEN** the gate shows plan depth and leverage
- **AND** visual artifacts are rendered or linked

### Requirement: Context pack visibility

Work-item detail SHALL show the context pack sources used for the change.

#### Scenario: Context sources
- **WHEN** a work item was dispatched with a context pack
- **THEN** the detail page lists the ADRs, constraints and prior failures used
