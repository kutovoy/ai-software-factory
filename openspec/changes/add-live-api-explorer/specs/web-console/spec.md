# Spec Delta

## ADDED Requirements

### Requirement: Executable API explorer

The API help entry SHALL provide a live Swagger UI that can execute requests.

#### Scenario: Render
- **WHEN** `/help/api` loads
- **THEN** the explorer renders operations from the served OpenAPI document
- **AND** "Try it out" is available on each operation

#### Scenario: Execute
- **WHEN** an operation is executed
- **THEN** the request goes to the console origin (`/api/v1/...`), never directly to the API host
- **AND** the response status and body are shown

#### Scenario: Destructive endpoint
- **WHEN** an operation can mutate state
- **THEN** the page states that actions run against this stack
- **AND** it states that the local API has no authentication

#### Scenario: Degraded
- **WHEN** JavaScript is unavailable or the document cannot be fetched
- **THEN** a static reference of the endpoints is still readable
- **AND** no empty shell is shown

### Requirement: Same-origin API proxy

The console SHALL expose `/api/v1/*` as a same-origin proxy to the backend.

#### Scenario: Forward
- **WHEN** a request hits `/api/v1/<path>` with any method
- **THEN** it is forwarded to the backend's `/api/v1/<path>` with query, body and headers
- **AND** the response status, headers and body are returned unchanged

#### Scenario: Unknown path
- **WHEN** the backend returns 404
- **THEN** the proxy returns 404 with the backend's error body
