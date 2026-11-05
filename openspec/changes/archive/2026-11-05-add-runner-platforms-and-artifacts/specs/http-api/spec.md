# Spec Delta

## ADDED Requirements

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
