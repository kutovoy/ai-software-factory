# code-forge Specification

## Purpose
Defines pluggable repository backends: a shared contract, a GitHub implementation with credential-by-reference,
and a dry-run mode for safe demos.

## Requirements

### Requirement: Shared forge contract

Every backend SHALL satisfy the same `CodeForge` contract, verified by one shared test suite.

#### Scenario: Contract parity
- **WHEN** the contract suite runs against a backend
- **THEN** checkout, branch, commit, PR, comment, checks and merge behave identically in shape
- **AND** errors use the same codes (`protected_branch`, `not_found`, `rate_limited`, `auth_failed`)

#### Scenario: Protected branch
- **WHEN** any stage writes to the default branch
- **THEN** the backend rejects with `protected_branch`
- **AND** the attempt is recorded

### Requirement: GitHub backend

The GitHub backend SHALL implement the contract against the REST API using a credential resolved by reference.

#### Scenario: Credential by reference
- **WHEN** a factory grants `GITHUB_TOKEN`
- **THEN** the client resolves it at run time
- **AND** the value never appears in definitions, events or logs

#### Scenario: Auth failure
- **WHEN** the token is missing, expired or lacks scope
- **THEN** calls fail with `auth_failed` including the missing scope when known

#### Scenario: Rate limit
- **WHEN** the API returns a rate-limit response
- **THEN** the client backs off and retries within the configured budget
- **AND** exhaustion surfaces `rate_limited` with reset time

#### Scenario: Offline contract test
- **WHEN** CI runs the GitHub backend tests
- **THEN** they use an injected `fetch` stub replaying recorded responses
- **AND** no network call is made unless `RUN_GITHUB=1`

### Requirement: Dry run

A dry-run mode SHALL make mutating calls no-ops while reporting intended actions.

#### Scenario: Dry run
- **WHEN** `GITHUB_DRY_RUN=1`
- **THEN** branch/commit/PR/merge calls return synthetic results
- **AND** the intended action is logged as an event
- **AND** the repository is unchanged

### Requirement: Forgejo backend

The forge client SHALL work against the local Forgejo instance and return resolvable PR URLs.

#### Scenario: Pull request
- **WHEN** a stage opens a pull request
- **THEN** it exists in Forgejo
- **AND** the recorded URL opens from the operator's machine

#### Scenario: API compatibility
- **WHEN** the client calls branch, commit, PR, checks or merge endpoints
- **THEN** Gitea-compatible differences are handled behind the `CodeForge` contract
- **AND** the shared contract suite stays green

#### Scenario: Token by reference
- **WHEN** the client authenticates
- **THEN** the token is resolved from a secret name at run time
- **AND** it never appears in definitions, events or logs
