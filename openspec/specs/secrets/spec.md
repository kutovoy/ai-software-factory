# secrets Specification

## Purpose
Defines a name-only secret registry: definitions reference names, values live outside the system, usage is
audited, and missing references are surfaced.

## Requirements

### Requirement: Name-only registry

The system SHALL store secret metadata without storing or returning values.

#### Scenario: Register
- **WHEN** a secret is created with a name, provider and scope
- **THEN** the registry records metadata only
- **AND** the response contains no value, masked or otherwise

#### Scenario: Value submitted
- **WHEN** a request includes a `value` field
- **THEN** it is rejected with `secret_value_rejected`

#### Scenario: Delete in use
- **WHEN** a secret is deleted while a definition references it
- **THEN** the request is refused with `secret_in_use` naming the resources

### Requirement: Presence check

The registry SHALL report whether a registered name currently resolves, without exposing the value.

#### Scenario: Resolved
- **WHEN** the name exists in the runtime environment
- **THEN** status is `resolved`

#### Scenario: Missing
- **WHEN** the name does not resolve
- **THEN** status is `unresolved`
- **AND** the page states that the first real run will fail until it is provided

### Requirement: Usage audit

Secret use SHALL be recorded per run by name only.

#### Scenario: Recorded
- **WHEN** a run resolves secrets for a lease
- **THEN** the run records the names used
- **AND** no value appears in events, logs or the database

#### Scenario: Usage view
- **WHEN** the Secrets page loads
- **THEN** each secret shows its last-used run and use count

### Requirement: Definition validation

Definitions SHALL warn when they reference an unregistered secret.

#### Scenario: Unregistered
- **WHEN** an agent or MCP server references a name that is not registered
- **THEN** validation emits a warning `secret_unregistered`
- **AND** the definition still validates
