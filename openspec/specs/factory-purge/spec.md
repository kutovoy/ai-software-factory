# factory-purge Specification

## Purpose
Deleting a factory removes all of its application state and leaves no rows that can resurface under a reused name.

## Requirements

### Requirement: Complete purge

The system SHALL remove every factory-scoped DB row, schedule and run artifact.

#### Scenario: Delete
- **WHEN** an owner/admin deletes a factory
- **THEN** its work items, runs, events, gates, scores, benchmarks, canary, improvement, merge, automation,
  MCP, integration and autonomy rows are removed
- **AND** its Temporal schedules are deleted
- **AND** running workflows are terminated
- **AND** its `runs/<id>/` directories are removed
- **AND** verification reports zero remaining rows

#### Scenario: Missing DB
- **WHEN** the purge cannot reach the database
- **THEN** it fails without deleting anything

#### Scenario: Active work
- **WHEN** the factory has active work items or running runs
- **THEN** deletion is refused unless `force` is set

### Requirement: Keep history

Git history and the forge repository SHALL survive a purge by default.

#### Scenario: Default
- **WHEN** a factory is purged without extra flags
- **THEN** the git definition history and forge PRs remain
