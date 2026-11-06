# Spec Delta

## ADDED Requirements

### Requirement: Retention policy

The system SHALL retain terminal runs, their event rows, run directories, artifact blobs and
canary candidate trees according to a configurable age and per-factory keep count.

#### Scenario: Aged run collected
- **WHEN** a terminal run is older than the retention age and is beyond the newest `keep` runs
  for its factory
- **THEN** its database rows, `runs/<id>/` directory and stored artifact blobs are removed
- **AND** the removal is idempotent on retry

#### Scenario: Active run protected
- **WHEN** a run is `pending` or `running`
- **THEN** it is never removed regardless of age or keep count

#### Scenario: Newest evidence kept
- **WHEN** a factory has more terminal runs than the keep count
- **THEN** the newest `keep` terminal runs are retained
- **AND** older runs beyond the keep count are eligible for removal

#### Scenario: Dry run
- **WHEN** retention runs with `dryRun`
- **THEN** it reports the runs and artifacts that would be removed
- **AND** it deletes nothing

### Requirement: Scheduled retention

The worker SHALL run retention on a configurable interval and SHALL NOT run it on remote hosts.

#### Scenario: Sweep
- **WHEN** `RETENTION_ENABLED` is set and the interval elapses
- **THEN** the worker sweeps every factory with recorded runs
- **AND** records a structured result with scanned, removed, kept, protected and error counts

#### Scenario: Disabled
- **WHEN** `RETENTION_ENABLED` is off
- **THEN** no scheduled sweep runs

### Requirement: Manual run GC

The API SHALL expose a factory-scoped manual run GC operation with an actor and reason.

#### Scenario: Manual GC
- **WHEN** an authorized operator posts a GC request for a factory
- **THEN** the API applies the same retention rules and returns counts for scanned, removed,
  kept and protected runs
- **AND** the operation is recorded in the structured log with the actor and reason

#### Scenario: Foreign factory
- **WHEN** a member requests GC for a factory they do not own
- **THEN** the API answers `404 factory_not_found`

### Requirement: Canary tree retention

Terminal canary candidate trees SHALL be pruned by the scheduled sweep and by the existing
manual prune route, while in-flight trees are protected.

#### Scenario: Scheduled prune
- **WHEN** the retention sweep visits a factory with terminal rollouts
- **THEN** trees beyond the configured keep count are removed
- **AND** pending/active rollout trees are protected

#### Scenario: Manual prune
- **WHEN** an operator prunes candidate trees
- **THEN** the response lists kept, removed and protected rollouts
- **AND** `canary.gc` is recorded for each removal

### Requirement: Artifact deletion

Stored artifact blobs SHALL be deletable through a short-lived signed request, and retention
SHALL attempt deletion before dropping the metadata.

#### Scenario: Delete stored object
- **WHEN** retention removes a run with a stored artifact
- **THEN** it issues a short-lived DELETE for the object key
- **AND** a transport failure is reported without rolling back the database delete
