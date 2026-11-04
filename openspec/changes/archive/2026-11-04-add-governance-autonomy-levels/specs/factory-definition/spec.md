# Spec Delta

## ADDED Requirements

### Requirement: Governance policy

Factories MAY declare `governance` with an autonomy level, model allowlist, deny actions,
human-required actions and audit export.

#### Scenario: Denied action
- **WHEN** an unattended run requests an action matching `denyActions`
- **THEN** the action is denied
- **AND** a `policy` run step records the decision and reason

#### Scenario: Human-required action
- **WHEN** an unattended run requests an action matching `requireHumanActions`
- **THEN** the action is denied
- **AND** the decision is recorded

#### Scenario: Observe/assist
- **WHEN** `autonomyLevel` is `observe` or `assist`
- **THEN** unattended actions require a human and are denied in a factory run

#### Scenario: Model allowlist
- **WHEN** a resolved model is outside `allowedModels`
- **THEN** work-item/run creation fails with `model_not_allowed`
- **AND** no run is started

### Requirement: Governance audit

Policy decisions SHALL be queryable per factory.

#### Scenario: Read
- **WHEN** `GET /api/v1/factories/:factoryId/governance` is requested
- **THEN** it returns the governance config, live autonomy state and recent decisions

#### Scenario: Export
- **WHEN** `/governance/audit` is requested
- **THEN** it returns the configured export mode and the decisions
