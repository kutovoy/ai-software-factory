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

### Requirement: Batch inbox projection

The API SHALL expose one owner-scoped inbox projection instead of requiring one list call per
factory plus one detail call per item.

#### Scenario: Response
- **WHEN** `GET /api/v1/inbox` is called
- **THEN** it returns pending gates, pending permissions and failed runs
- **AND** each category carries a total count
- **AND** each row carries the factory id/name and the link target

#### Scenario: Owner scope
- **WHEN** a member calls the inbox
- **THEN** only rows they own are returned
- **AND** an admin sees all rows

#### Scenario: Limit
- **WHEN** `limit` is supplied
- **THEN** each category is capped at that size (1–100)
- **AND** the counts still describe the full queue

### Requirement: Board projection and cursors

The work-items list SHALL support a batch board view and opaque keyset cursors.

#### Scenario: Board view
- **WHEN** `GET /api/v1/factories/{factoryId}/work-items?view=board` is called
- **THEN** each card includes its summary, newest pending gate and run-link events
- **AND** the response includes status counts, total and `nextCursor`
- **AND** no per-card detail request is needed

#### Scenario: Status filter
- **WHEN** `status` is a comma-separated list
- **THEN** only matching statuses are returned
- **AND** the default excludes cancelled items

#### Scenario: Cursor
- **WHEN** `cursor` is supplied from a previous board response
- **THEN** the next page starts after that `(created_at, id)` pair
- **AND** an invalid cursor falls back to the first page

#### Scenario: Contract
- **WHEN** the OpenAPI parity test runs
- **THEN** `/api/v1/inbox` and the board/cursor parameters are documented

### Requirement: Artifact upload and download routes

The versioned API SHALL expose agent artifact-presign and viewer artifact-download routes.

#### Scenario: Presign route
- **WHEN** an authenticated agent posts artifact metadata for its run
- **THEN** `POST /api/v1/runner-agent/artifacts/presign` returns presigned PUT grants
- **AND** a missing or invalid bearer token is `agent_unauthorized`

#### Scenario: Download route
- **WHEN** an authorized viewer requests a run artifact by path
- **THEN** `GET /api/v1/factories/:factoryId/runs/:runId/artifacts?path=...` returns a
  presigned redirect or the local file
- **AND** a path traversal attempt is refused

### Requirement: Platform-aware enrollment commands

Enrollment responses SHALL include commands appropriate for the selected platform.

#### Scenario: Windows commands
- **WHEN** an enrollment is created with `platform=windows`
- **THEN** `preflightCommand` and `installCommand` are PowerShell
- **AND** the install command selects the native backend

#### Scenario: macOS commands
- **WHEN** an enrollment is created with `platform=macos`
- **THEN** `preflightCommand` and `installCommand` are bash
- **AND** the install command selects the native backend
