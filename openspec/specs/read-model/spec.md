# read-model Specification

## Purpose
A Postgres read model derived from the canonical event log: projections can be rebuilt at any
time, and the append-only log remains the audit trail.

## Requirements

### Requirement: Rebuildable read model

The Postgres projection SHALL be reconstructable from the canonical event log at any time.

#### Scenario: Rebuild
- **WHEN** `factory rebuild --from runs/` runs
- **THEN** every run, step and event in the JSONL logs is upserted in `(runId, seq)` order
- **AND** the operation is idempotent (a second run reports no changes)

#### Scenario: Dry run
- **WHEN** `--dry-run` is passed
- **THEN** the diff is reported (missing, extra, divergent rows)
- **AND** no row is written or deleted

#### Scenario: Divergence
- **WHEN** a row exists in Postgres but not in the log
- **THEN** it is reported as `orphaned`
- **AND** it is not deleted automatically

#### Scenario: Ordering violation
- **WHEN** a log has a gap or duplicate `seq`
- **THEN** the rebuild fails with `event_log_corrupt` naming the run and sequence

### Requirement: Factory registry read model

The `factories` registry SHALL carry the derived metadata needed by the console read path, and
factory reads SHALL NOT re-scan the filesystem or run git inside the common path.

#### Scenario: List from registry
- **WHEN** `GET /api/v1/factories` is called while the registry is fresh
- **THEN** the response is built from indexed `factories` rows
- **AND** no definition directory is scanned and no git subprocess runs

#### Scenario: Resolve from registry
- **WHEN** a factory-scoped route resolves a `fac_<ulid>` id
- **THEN** the registry row is read by primary key with the viewer's owner scope
- **AND** an unknown or foreign id is `404 factory_not_found`

#### Scenario: Bounded sync
- **WHEN** the registry is older than `FACTORY_REGISTRY_TTL_MS`
- **THEN** one single-flight sync rebuilds the derived columns
- **AND** concurrent requests share that sync

#### Scenario: Miss
- **WHEN** an id is missing from a fresh registry
- **THEN** one forced sync runs at most once per TTL
- **AND** a genuinely unknown id remains a 404

#### Scenario: Database unavailable
- **WHEN** the database cannot be read
- **THEN** the filesystem projection still answers the request
- **AND** the response does not fail because the registry is derived

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
