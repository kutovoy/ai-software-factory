# http-api Specification

## Purpose
Defines the public HTTP surface: a single versioned prefix, an OpenAPI document that matches the routes, and a
stable unversioned liveness endpoint.

## Requirements

### Requirement: Versioned prefix

Every public endpoint SHALL live under `/api/v1`, except the liveness probe.

#### Scenario: Resource call
- **WHEN** a client calls a resource endpoint
- **THEN** it uses `/api/v1/<resource>`
- **AND** the unversioned path is not served

#### Scenario: Health
- **WHEN** a probe calls `GET /health`
- **THEN** it succeeds without a version prefix
- **AND** `GET /api/v1/health` is also available for versioned clients

#### Scenario: Breaking change
- **WHEN** a response shape or required field changes incompatibly
- **THEN** a new version prefix is introduced
- **AND** the old one keeps working until removed deliberately

### Requirement: OpenAPI parity

The OpenAPI document SHALL describe every served route, and a test SHALL fail on any divergence.

#### Scenario: Served and documented
- **WHEN** the contract test compares the route table with `openapi.json`
- **THEN** every route appears in the document
- **AND** every documented path is served

#### Scenario: Served but undocumented
- **WHEN** a route exists without a spec entry
- **THEN** the test fails naming method and path

#### Scenario: Documented but missing
- **WHEN** the spec lists a path that is not registered
- **THEN** the test fails naming method and path

#### Scenario: Spec access
- **WHEN** `GET /api/v1/openapi.json` is called
- **THEN** it returns the document
- **AND** it is usable by Swagger UI and Postman
