# factory-identity Specification

## Purpose
Factories have stable, unguessable IDs, private owners and nested URLs.

## Requirements

### Requirement: Stable factory ID

Each factory SHALL have a committed `fac_<ulid>` id.

#### Scenario: Definition
- **WHEN** a factory is loaded at runtime
- **THEN** `factory.yaml` contains a valid `id`
- **AND** a missing id fails with `factory_id_missing`

#### Scenario: Registry
- **WHEN** a definition is listed or resolved
- **THEN** the registry maps its id to owner, name, path and key

### Requirement: Owner scope

Factories SHALL be private to their owner unless the caller is an admin.

#### Scenario: Member list
- **WHEN** a member lists factories
- **THEN** only factories they own are returned

#### Scenario: Cross-user access
- **WHEN** a member requests another user's factory by id or nested work item/run
- **THEN** the response is `404 not_found`

### Requirement: Nested URLs

Factory resources SHALL be addressed through the factory id.

#### Scenario: Dashboard
- **WHEN** the console opens `/factories/<factory_id>/dashboard`
- **THEN** the dashboard for that factory is rendered

#### Scenario: Work item and run
- **WHEN** a work item or run is opened
- **THEN** its URL is `/factories/<factory_id>/work-items/<id>` or `/factories/<factory_id>/runs/<id>`

### Requirement: Name reuse

Two users SHALL be able to own factories with the same local name.

#### Scenario: Same name
- **WHEN** user A and user B both create `hello-nextjs`
- **THEN** they have different ids and paths (`A/hello-nextjs`, `B/hello-nextjs`)
- **AND** neither can access the other's factory

### Requirement: Unified factory paths

Every factory-scoped API resource SHALL live under `/api/v1/factories/:factoryId/...`.

#### Scenario: Scores
- **WHEN** scores are listed or read
- **THEN** the paths are `/factories/:factoryId/scores` and `/factories/:factoryId/scores/:scoreId`

#### Scenario: Improvement
- **WHEN** proposals, lessons, calibration or scoring are accessed
- **THEN** they are nested under the factory path

#### Scenario: No factory query
- **WHEN** a factory-scoped request is made
- **THEN** it carries the factory in the path, not `?factory=` or `?factoryId=`

### Requirement: Browser parity

Factory-scoped pages SHALL live under `/factories/<id>/...`.

#### Scenario: Score detail
- **WHEN** a score is opened
- **THEN** the URL is `/factories/<id>/scores/<scoreId>`

#### Scenario: MCPs
- **WHEN** MCPs are opened
- **THEN** the URL is `/factories/<id>/mcps`
