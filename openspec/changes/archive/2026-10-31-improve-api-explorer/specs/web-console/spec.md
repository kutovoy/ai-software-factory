# Spec Delta

## ADDED Requirements

### Requirement: Explorer presentation parity

The API explorer SHALL use the available width and expose search, sorting and request metadata.

#### Scenario: Full width
- **WHEN** `/help/api` renders at 1280px or wider
- **THEN** the explorer uses the content width rather than a narrow column
- **AND** prose blocks stay readable

#### Scenario: Filter and sort
- **WHEN** the explorer is shown
- **THEN** a filter box narrows operations
- **AND** tags and operations are sorted alphabetically
- **AND** each executed request shows its duration

#### Scenario: Tag context
- **WHEN** a tag group is expanded
- **THEN** its description is shown

### Requirement: Truthful server selector

The explorer's Servers selector SHALL name the origin that requests actually use.

#### Scenario: Console origin
- **WHEN** the console loads the explorer document
- **THEN** the server entry is the console origin (`/`), not the backend host
- **AND** executing an operation reaches `/api/v1/...` through the same-origin proxy

#### Scenario: Raw document
- **WHEN** a client fetches `/api/v1/openapi.json` without the console parameter
- **THEN** the document keeps the direct API server for Swagger UI/Postman use
