# Spec Delta

## Purpose

Defines the machine-checkable validation contract a work item must satisfy, its QA tiers,
evidence and the verify-gate enforcement.

## ADDED Requirements

### Requirement: Contract creation

A work item SHALL receive a validation contract when the factory enables validation.

#### Scenario: Build from factory and repository
- **WHEN** a work item is created for a factory with validation enabled
- **THEN** the contract records the work-item id, factory, definition commit and creation time
- **AND** it contains at least one check with `id`, `title`, `tier`, `required`, `evidence` and optional `command`
- **AND** tiers are drawn from `unit`, `component`, `integration`, `e2e` and `manual`

#### Scenario: Inferred checks
- **WHEN** the factory declares no explicit checks
- **THEN** the builder infers checks from repository scripts for typecheck, lint, test, build and e2e
- **AND** it always adds a manual acceptance check for the work-item title

#### Scenario: Explicit checks
- **WHEN** the factory declares `validation.checks`
- **THEN** those checks are used as declared
- **AND** the contract keeps the factory's `enforce` setting

### Requirement: QA pyramid

The contract SHALL express the QA pyramid as tiers rather than requiring one test tool.

#### Scenario: Tier coverage
- **WHEN** a repository has unit tests and a Playwright configuration
- **THEN** the contract contains unit, integration and e2e checks
- **AND** a manual acceptance check remains required

#### Scenario: Missing tier
- **WHEN** a required tier has no evidence
- **THEN** the projection reports that check as `missing`
- **AND** the contract is not complete

### Requirement: Evidence

The verify stage SHALL accept evidence from the QA agent and forge checks.

#### Scenario: Agent evidence
- **WHEN** the verify agent ends its summary with a fenced JSON block containing `validation`
- **THEN** each entry maps to a contract check id with `status` `pass` or `fail` and an evidence string
- **AND** a `validation.evidence` event records the parsed evidence

#### Scenario: Forge evidence
- **WHEN** forge checks are recorded
- **THEN** check names matching a contract id or title supply pass/fail evidence
- **AND** forge evidence does not override explicit agent evidence

#### Scenario: Missing evidence
- **WHEN** a required check has neither agent nor forge evidence
- **THEN** its status is `missing`
- **AND** the contract is incomplete

### Requirement: Enforcement

A verify gate SHALL NOT approve while the contract is incomplete when `validation.enforce` is true.

#### Scenario: Human approval refused
- **WHEN** a human tries to approve the verify gate with required evidence missing
- **THEN** the API refuses with `validation_incomplete`
- **AND** the response lists the missing check ids

#### Scenario: Agent gate
- **WHEN** an agent-gated verify stage has incomplete required evidence
- **THEN** the stage gate resolves `request_changes`
- **AND** the feedback names the missing checks

#### Scenario: Enforcement off
- **WHEN** `validation.enforce` is false
- **THEN** the contract is projected but the verify gate is not blocked

### Requirement: Projection

The work-item detail SHALL project the contract and its current evidence.

#### Scenario: Detail
- **WHEN** a work item is read
- **THEN** `validation` contains `contract`, `checks`, `complete` and `missing`
- **AND** each check reports `status`, `source` and optional `evidence`

#### Scenario: No contract
- **WHEN** validation is disabled or no contract exists
- **THEN** `validation` is `null`
- **AND** no checks are invented
