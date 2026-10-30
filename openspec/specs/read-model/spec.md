# read-model Specification

## Purpose
TBD - created by archiving change harden-runtime. Update Purpose after archive.

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
