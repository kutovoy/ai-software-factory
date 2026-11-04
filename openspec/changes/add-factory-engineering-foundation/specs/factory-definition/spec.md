# Spec Delta

## Purpose

Extend the factory definition with optional validation, readiness and guard configuration.

## ADDED Requirements

### Requirement: Validation block

`factory.yaml` SHALL accept an optional `validation` block.

#### Scenario: Shape
- **WHEN** a factory declares `validation`
- **THEN** it may declare `enabled`, `enforce`, `tiers` and `checks`
- **AND** each check has `id`, `title`, `tier`, `required`, `evidence` and optional `command`
- **AND** invalid tiers or empty check ids fail validation with a stable code

#### Scenario: Defaults
- **WHEN** the block is absent
- **THEN** validation is enabled and enforcement is off
- **AND** checks are inferred at work-item creation

### Requirement: Readiness block

`factory.yaml` SHALL accept an optional `readiness` block.

#### Scenario: Shape
- **WHEN** a factory declares `readiness`
- **THEN** it may declare `enforceAutonomy` and `thresholds.ready` / `thresholds.warn`
- **AND** thresholds are integers between 0 and 100 with `warn <= ready`

#### Scenario: Defaults
- **WHEN** the block is absent
- **THEN** readiness is advisory only
- **AND** the default thresholds are 80 and 60

### Requirement: Guard block

`factory.yaml` SHALL accept an optional `guard` block.

#### Scenario: Shape
- **WHEN** a factory declares `guard`
- **THEN** it may declare `enabled`, `secretScan`, `protectedBranches`, `maxChangedFiles`, `maxPatchBytes` and `binaryFileLimit`
- **AND** limits are positive integers

#### Scenario: Defaults
- **WHEN** the block is absent
- **THEN** guard hooks are enabled with the default protected branches `main` and `master`
- **AND** the default limits are finite and documented
