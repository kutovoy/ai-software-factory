# Spec Delta

## ADDED Requirements

### Requirement: Surface parity

Every user-facing surface SHALL use the same API run path; no surface may execute tools
outside a runner.

#### Scenario: CLI chat
- **WHEN** `factory run` is invoked
- **THEN** it starts a chat run through `POST /api/v1/factories/:factoryId/chat`
- **AND** the worker leases a runner exactly as the console does

#### Scenario: CI intake
- **WHEN** a CI step uses `factory intake` or posts to `/intake/generic`
- **THEN** a normal work item enters the factory loop
- **AND** no CI-specific execution path exists

#### Scenario: Slack
- **WHEN** Slack posts to `/intake/slack`
- **THEN** the Slack signature is verified
- **AND** the work item uses the Slack source and untrusted framing
