# Spec Delta

## ADDED Requirements

### Requirement: Improvement authority configuration

`factory.yaml` SHALL declare an `improvement` block with an authority level, and the value SHALL be validated
against the supported levels.

#### Scenario: Valid authority
- **WHEN** `improvement.authority` is one of `propose_only`, `auto_merge_on_benchmark`, `canary`
- **THEN** the definition validates

#### Scenario: Invalid authority
- **WHEN** `improvement.authority` is any other value
- **THEN** validation fails with `invalid_value` naming the field and allowed values

#### Scenario: Default
- **WHEN** the `improvement` block is omitted
- **THEN** the authority defaults to `propose_only`
- **AND** the resolved configuration reports the default explicitly

#### Scenario: Canary requires parameters
- **WHEN** authority is `canary`
- **THEN** `improvement.canaryPercent` (1–100) and `improvement.rollbackThreshold` are required
- **AND** validation fails with `missing_field` otherwise
