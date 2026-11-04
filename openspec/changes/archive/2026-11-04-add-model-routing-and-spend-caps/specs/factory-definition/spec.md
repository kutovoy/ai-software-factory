# Spec Delta

## ADDED Requirements

### Requirement: Classifier routing

`routing.yaml` SHALL support an optional `classifier` block with `cheap`, `standard` and
`deep` tiers. When enabled, a deterministic classifier SHALL select a tier from the task
prompt and stage.

#### Scenario: Cheap task
- **WHEN** a triage or small documentation task is classified
- **THEN** the cheap tier's inference is selected

#### Scenario: Deep task
- **WHEN** a review or a prompt containing security/migration/architecture terms is classified
- **THEN** the deep tier's inference is selected

#### Scenario: Disabled classifier
- **WHEN** `classifier.enabled` is false
- **THEN** `stages[stage]` then `default` are used
- **AND** an absent route keeps the agent/default model

### Requirement: Spend caps

`factory.yaml` SHALL support optional `budget.maxCostUsdPerRun`,
`budget.maxCostUsdPerStage` and `budget.maxCostUsdPerFactory`.

#### Scenario: Per-run cap
- **WHEN** a run's accumulated `usage.updated.costUsd` exceeds its cap
- **THEN** the run stops with `budget_exhausted`
- **AND** the run is recorded as an error

#### Scenario: Per-stage cap
- **WHEN** a stage declares a stage cap
- **THEN** that cap applies to the stage run instead of the run cap

#### Scenario: Factory cap
- **WHEN** a factory's recorded spend reaches `maxCostUsdPerFactory`
- **THEN** new work items/runs are refused with `factory_budget_exhausted`
- **AND** existing runs are not retroactively failed

#### Scenario: Budget status
- **WHEN** `GET /api/v1/factories/:factoryId/budget` is requested
- **THEN** it returns the configured caps, recorded spend and exhaustion state
