# Spec Delta

## ADDED Requirements

### Requirement: Factory registry read model

The `factories` registry SHALL carry the derived metadata needed by the console read path, and
factory reads SHALL NOT re-scan the filesystem or run git inside the common path.

#### Scenario: List from registry
- **WHEN** `GET /api/v1/factories` is called while the registry is fresh
- **THEN** the response is built from indexed `factories` rows
- **AND** no definition directory is scanned and no git subprocess runs

#### Scenario: Resolve from registry
- **WHEN** a factory-scoped route resolves a `fac_<ulid>` id
- **THEN** the registry row is read by primary key with the viewer's owner scope
- **AND** an unknown or foreign id is `404 factory_not_found`

#### Scenario: Bounded sync
- **WHEN** the registry is older than `FACTORY_REGISTRY_TTL_MS`
- **THEN** one single-flight sync rebuilds the derived columns
- **AND** concurrent requests share that sync

#### Scenario: Miss
- **WHEN** an id is missing from a fresh registry
- **THEN** one forced sync runs at most once per TTL
- **AND** a genuinely unknown id remains a 404

#### Scenario: Database unavailable
- **WHEN** the database cannot be read
- **THEN** the filesystem projection still answers the request
- **AND** the response does not fail because the registry is derived
