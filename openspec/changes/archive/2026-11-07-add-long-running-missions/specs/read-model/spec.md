# Spec Delta

## ADDED Requirements

### Requirement: Mission projections

The read model SHALL expose mission list/detail projections without N+1 calls.

#### Scenario: List
- **WHEN** a client lists missions
- **THEN** each row carries status, progress counts, current milestone and spend
- **AND** owner and factory scope are applied in SQL

#### Scenario: Detail
- **WHEN** a client reads a mission
- **THEN** one response carries the plan, milestones, features, checkpoints, validations, pending gate,
  linked work items and budget
