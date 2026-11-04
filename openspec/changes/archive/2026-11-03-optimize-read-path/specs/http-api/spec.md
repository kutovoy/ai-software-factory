# Spec Delta

## ADDED Requirements

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
