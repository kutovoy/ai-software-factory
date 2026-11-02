# Spec Delta

## Purpose

Factory-scoped API and browser resources are addressed only through the factory id.

## ADDED Requirements

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
