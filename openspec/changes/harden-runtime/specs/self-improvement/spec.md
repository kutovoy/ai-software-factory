# Spec Delta

## ADDED Requirements

### Requirement: Canary artefact lifecycle

Candidate trees SHALL be garbage-collected after a rollout reaches a terminal state.

#### Scenario: Collect
- **WHEN** a rollout is promoted or rolled back
- **THEN** its candidate tree is retained for the configured number of rollouts
- **AND** older trees are removed

#### Scenario: In-flight protection
- **WHEN** a tree belongs to an active rollout
- **THEN** it is never removed

### Requirement: Rollout time series

Canary metrics SHALL be available as a time series over the observation window.

#### Scenario: Series
- **WHEN** the canary panel loads
- **THEN** it shows hourly buckets of pass rate, run count and error rate per version
- **AND** the series is derived from scores and runs, not stored separately

#### Scenario: Sparse data
- **WHEN** a bucket has no runs
- **THEN** it is returned as `null` with a reason
- **AND** the chart does not interpolate it as zero

### Requirement: Promotion hook

Promotion SHALL apply the candidate to the local checkout or record that it is pending.

#### Scenario: Hook configured
- **WHEN** a factory declares a `deployHook`
- **THEN** promotion runs it after merging the candidate PR
- **AND** a failure marks the rollout `promoted_pending_deploy` with the error

#### Scenario: No hook
- **WHEN** no hook is configured
- **THEN** promotion records `promotion_pending_deploy`
- **AND** it does not claim the checkout was updated
