# Spec Delta

## ADDED Requirements

### Requirement: Mission Control

The console SHALL provide a factory-scoped Missions list and detail view.

#### Scenario: List
- **WHEN** a user opens the Missions page
- **THEN** each mission shows title, status, progress, current milestone, spend and updated time
- **AND** the page offers a create-mission form

#### Scenario: Detail
- **WHEN** a user opens a mission
- **THEN** the page shows the plan, validation contract, milestones, features, dependencies, checkpoints,
  validation evidence, linked work items/runs/PRs and budget
- **AND** it shows pending plan approval and blocked state

#### Scenario: Controls
- **WHEN** a mission is awaiting plan approval, running, paused or blocked
- **THEN** the page offers the applicable approve/reject/request-changes, pause/resume, cancel and retry
  controls
- **AND** the Inbox lists pending mission plan gates and blocked missions
