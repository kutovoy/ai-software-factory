# Spec Delta

## Purpose

Defines how work enters the factory: verified webhooks from code forges and trackers, and scheduled automations.

## ADDED Requirements

### Requirement: Webhook verification

Webhook endpoints SHALL verify the provider signature before parsing and SHALL reject unsigned or invalid
requests.

#### Scenario: Valid signature
- **WHEN** a request carries a valid `X-Hub-Signature-256` for the configured secret
- **THEN** the payload is accepted

#### Scenario: Invalid signature
- **WHEN** the signature is missing or does not match
- **THEN** the request is rejected with `invalid_signature`
- **AND** no work item is created

#### Scenario: Secret by reference
- **WHEN** a webhook is configured
- **THEN** it references a secret name, never an inline value

### Requirement: Delivery dedupe and bot filtering

Webhook deliveries SHALL be idempotent, and bot-authored events SHALL be skipped by default.

#### Scenario: Duplicate delivery
- **WHEN** the same `X-GitHub-Delivery` id arrives twice
- **THEN** the second is acknowledged and ignored

#### Scenario: Bot sender
- **WHEN** the sender is a bot and `skip_bots` is `all`
- **THEN** no work item is created
- **AND** the skip is recorded

#### Scenario: Payload framing
- **WHEN** payload text is passed to an agent
- **THEN** it is framed as untrusted data
- **AND** payload size is capped with `payload_too_large` beyond the limit

### Requirement: Trigger filters

Automations SHALL filter events by repository, labels, branches and event type before creating work.

#### Scenario: Label trigger
- **WHEN** an issue is labeled `factory-ready` in a configured repo
- **THEN** a work item is created with `source: github` and `sourceRef` pointing at the issue
- **AND** the factory's foreman is notified

#### Scenario: Non-matching event
- **WHEN** an event does not match the filters
- **THEN** it is acknowledged and ignored
- **AND** the reason is recorded

### Requirement: Scheduled automations

Automations with a schedule SHALL run on a durable timer and SHALL be pausable.

#### Scenario: Cron
- **WHEN** an automation declares a schedule
- **THEN** a Temporal schedule starts a work item at each fire
- **AND** each fire is idempotent by schedule id + timestamp

#### Scenario: Pause
- **WHEN** an automation is disabled
- **THEN** its schedule pauses
- **AND** no new work items are created
