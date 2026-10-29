# merge-queue Specification

## Purpose
Defines a serialized merge queue that lands agent PRs safely: batched merges, gated merged stack, bisect on
failure, and revert on red.

## Requirements

### Requirement: Serialized merging

A factory SHALL have at most one merge batch in flight, and agents SHALL NOT merge directly.

#### Scenario: Queue ownership
- **WHEN** a stage finishes implementation
- **THEN** it opens a PR and enqueues it
- **AND** only the merge queue may merge it

#### Scenario: Single batch
- **WHEN** a batch is in flight
- **THEN** newly enqueued PRs wait for the next batch

### Requirement: Batch gating

The queue SHALL merge a batch only after validating the merged stack against required checks.

#### Scenario: Green batch
- **WHEN** every PR in the batch is ready and the merged stack passes required checks
- **THEN** the batch merges as a single unit
- **AND** each PR is marked merged with the batch id

#### Scenario: Red stack
- **WHEN** the merged stack fails checks
- **THEN** the queue bisects to isolate the offending PR
- **AND** merges the remaining clean subset
- **AND** marks the offender `needs_human` with the failure evidence

#### Scenario: Check timeout
- **WHEN** required checks do not complete within the configured timeout
- **THEN** the batch fails with `checks_timeout`
- **AND** nothing merges

### Requirement: Revert on red

If the default branch fails after a batch merge, the queue SHALL revert the batch.

#### Scenario: Post-merge failure
- **WHEN** the default branch goes red after a batch
- **THEN** the queue creates a single revert commit for the batch
- **AND** emits `merge.reverted` with the failing checks and PR list

#### Scenario: Manual revert
- **WHEN** a human triggers a revert
- **THEN** the batch is reverted regardless of checks
- **AND** the action is audited
