# Spec Delta

## ADDED Requirements

### Requirement: Local forge

The stack SHALL run a Forgejo instance reachable from the console origin.

#### Scenario: Served under the console
- **WHEN** `/extras/forgejo` is opened on the console origin
- **THEN** the forge UI renders with working assets and links
- **AND** generated URLs include the subpath

#### Scenario: Enabled by default
- **WHEN** the stack starts with default settings
- **THEN** the forge is running and healthy
- **AND** it can be disabled explicitly by configuration

#### Scenario: Internal only
- **WHEN** the forge is reached from outside the compose network
- **THEN** it is only reachable through the console proxy
- **AND** the identity header cannot be spoofed from the browser

### Requirement: Single-user auto-login

The forge SHALL log the operator in without a second credential prompt in single-user mode.

#### Scenario: Proxy identity
- **WHEN** a request reaches the forge through the console proxy
- **THEN** the seeded admin identity is asserted by a trusted header
- **AND** Forgejo does not ask for a password

#### Scenario: Mode is stated
- **WHEN** the operator reads the integrations/help surface
- **THEN** it says this is single-user local mode
- **AND** it names the multi-user path (OIDC + per-user organizations)

### Requirement: Bootstrap

A bootstrap step SHALL provision the admin, a token, an organization and a repository idempotently.

#### Scenario: First run
- **WHEN** the bootstrap runs on a fresh forge
- **THEN** the admin exists, a token is created and stored as a secret reference
- **AND** the organization and repository exist

#### Scenario: Re-run
- **WHEN** the bootstrap runs again
- **THEN** it succeeds without duplicating users, tokens, orgs or repos

#### Scenario: Token handling
- **WHEN** the token is created
- **THEN** it is written to the environment file only
- **AND** it is never printed to logs or stored in definitions

### Requirement: Multi-user path

The design SHALL document how users are isolated without requiring Keycloak.

#### Scenario: Isolation
- **WHEN** the console authenticates a user in a later phase
- **THEN** the proxy asserts that user instead of the admin
- **AND** Forgejo OIDC group mappings place the user in a per-user organization/team
- **AND** users only see their own projects
