# Spec Delta

## ADDED Requirements

### Requirement: Budget enforcement

The run lifecycle SHALL enforce spend caps and record an actionable terminal error.

#### Scenario: Exceeded
- **WHEN** a run crosses `maxCostUsd`
- **THEN** the event pump stops the run with `budget_exhausted`
- **AND** the run ends `error` with that code in the failure message

#### Scenario: No cap
- **WHEN** no budget is configured
- **THEN** the run behaves exactly as before

### Requirement: Budget observability

The API SHALL expose configured caps and current spend for a factory.

#### Scenario: Read
- **WHEN** the budget endpoint is requested
- **THEN** it returns `maxCostUsdPerRun`, `maxCostUsdPerStage`, `maxCostUsdPerFactory`,
  `spentUsd` and `exhausted`
