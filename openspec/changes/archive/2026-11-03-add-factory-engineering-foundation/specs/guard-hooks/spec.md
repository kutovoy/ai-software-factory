# Spec Delta

## Purpose

Defines deterministic, fail-closed checks that run before a factory pull request is
committed, and how their results are recorded and exposed.

## ADDED Requirements

### Requirement: Pure checks

Guard hooks SHALL be pure functions over the branch, applied files and factory configuration.

#### Scenario: No side effects
- **WHEN** a guard hook runs
- **THEN** it does not execute shell commands, network calls or writes
- **AND** it returns a report with `passed` and per-check `id`, `status`, `detail`

### Requirement: Protected branch

The guard SHALL reject writes to protected branches.

#### Scenario: Protected
- **WHEN** the target branch is listed in `guard.protectedBranches` or is the repository default
- **THEN** the guard fails with `protected_branch`
- **AND** no commit or pull request is created

### Requirement: Path containment

The guard SHALL reject paths outside the workspace and reserved git paths.

#### Scenario: Escape
- **WHEN** an applied file path is absolute, contains `..`, or starts with `.git/`
- **THEN** the guard fails with `path_outside_workspace`
- **AND** the offending path is reported

### Requirement: Secret scan

The guard SHALL reject known secret patterns in added file content.

#### Scenario: Known token
- **WHEN** an applied file contains a known token prefix or a private-key header
- **THEN** the guard fails with `secret_detected`
- **AND** the report names the pattern and file, never the secret value

#### Scenario: Clean
- **WHEN** no known pattern matches
- **THEN** the guard passes that check

### Requirement: Size limits

The guard SHALL enforce configured limits on changed files and patch size.

#### Scenario: Too many files
- **WHEN** the applied file count exceeds `guard.maxChangedFiles`
- **THEN** the guard fails with `too_many_files`

#### Scenario: Too large
- **WHEN** the total patch size exceeds `guard.maxPatchBytes`
- **THEN** the guard fails with `patch_too_large`

### Requirement: Integration and evidence

The guard SHALL run before the forge commit and SHALL record its result on the work item.

#### Scenario: Pass
- **WHEN** every check passes
- **THEN** a `guard.checked` event records `passed: true` and the check list
- **AND** the PR is committed normally

#### Scenario: Fail
- **WHEN** any check fails
- **THEN** a `guard.failed` event records the failing checks
- **AND** the forge activity fails non-retryably with `guard_failed`

### Requirement: API

The resolved guard configuration and recent results SHALL be exposed per factory.

#### Scenario: Read
- **WHEN** `GET /api/v1/factories/{factoryId}/guard-hooks` is called
- **THEN** the response contains the resolved config and recent `guard.*` events
- **AND** it does not expose secret values
