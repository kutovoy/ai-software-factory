# Spec Delta

## ADDED Requirements

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
