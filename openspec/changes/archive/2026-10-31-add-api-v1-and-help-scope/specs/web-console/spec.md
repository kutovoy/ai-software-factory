# Spec Delta

## ADDED Requirements

### Requirement: Pinned sidebar footer

The sidebar SHALL remain a fixed-height, independently scrolling column so its footer stays visible.

#### Scenario: Long page
- **WHEN** a long page (e.g. Help) is open
- **THEN** the sidebar does not grow with the page
- **AND** the usage/account/help footer remains visible at the bottom left
- **AND** only the sidebar's nav list scrolls

#### Scenario: Short page
- **WHEN** a short page is open
- **THEN** the footer sits at the bottom of the viewport
- **AND** the layout does not shift between pages

### Requirement: API reference in help

The console SHALL expose the HTTP API inside the product.

#### Scenario: Nav entry
- **WHEN** the sidebar is rendered
- **THEN** an `API` entry appears above `Help`
- **AND** it opens the API help entry

#### Scenario: Reference
- **WHEN** the API help entry loads
- **THEN** it lists every endpoint with method, path, purpose and parameters
- **AND** it links to the raw OpenAPI document

### Requirement: Supported projects guidance

Help SHALL state what the factory can and cannot build.

#### Scenario: In scope
- **WHEN** the supported-projects entry is read
- **THEN** it explains that the unit of work is a repository diff verified by checks
- **AND** it gives examples: application code, tests, documentation, configuration, Terraform modules and plans

#### Scenario: Out of scope
- **WHEN** a request needs applying infrastructure, physical action, or an artefact no check can verify
- **THEN** the entry says the factory will produce a proposal/PR at most
- **AND** it does not claim the factory performs the action
