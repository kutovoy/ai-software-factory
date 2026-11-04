# Spec Delta

## ADDED Requirements

### Requirement: External intake

The API SHALL accept work from generic, Sentry, PostHog, Slack, Linear and Jira intake
providers and create a normal work item.

#### Scenario: Accepted
- **WHEN** a provider posts a valid payload
- **THEN** a work item is created with the provider as its `source`
- **AND** `sourceRef` records the external id, url and `untrusted: true`
- **AND** the prompt is framed as untrusted data

#### Scenario: Duplicate
- **WHEN** the same external delivery id is posted again
- **THEN** the response is `202` with `status: ignored` and `reason: duplicate_delivery`
- **AND** no second work item is created

#### Scenario: Signature
- **WHEN** a provider secret is configured and the signature does not match
- **THEN** the delivery is marked `rejected` with `invalid_signature`
- **AND** no work item is created

#### Scenario: Unknown provider
- **WHEN** the provider is not supported
- **THEN** the response is `404 unsupported_provider`

### Requirement: Intake audit

Recent intake deliveries SHALL be queryable per factory.

#### Scenario: List
- **WHEN** `GET /api/v1/factories/:factoryId/intake` is requested
- **THEN** it returns intake-provider deliveries for that factory
- **AND** each delivery shows status, reason and any work item id
