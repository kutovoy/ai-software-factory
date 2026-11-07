# Spec Delta

## ADDED Requirements

### Requirement: Mission API

The API SHALL expose factory-scoped mission routes under `/api/v1/factories/{factoryId}/missions`.

#### Scenario: Create and read
- **WHEN** a client creates a mission
- **THEN** the response carries the mission id, status, pinned definition commit and workflow id
- **AND** list and detail routes are owner-scoped and factory-scoped

#### Scenario: Plan decision
- **WHEN** a client posts a plan decision
- **THEN** the decision is `approve`, `reject` or `request_changes`
- **AND** it is delivered to the mission workflow by Update or Signal
- **AND** the decision, actor and timestamp are recorded

#### Scenario: Control
- **WHEN** a client pauses, resumes, cancels or retries a feature
- **THEN** the API records the request and returns the updated mission or feature state

#### Scenario: OpenAPI parity
- **WHEN** the contract test compares the route table with `openapi.json`
- **THEN** every mission route is documented
