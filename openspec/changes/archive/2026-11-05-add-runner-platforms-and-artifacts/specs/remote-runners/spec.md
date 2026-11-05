# Spec Delta

## ADDED Requirements

### Requirement: Platform-specific agents

The runner agent SHALL support native Linux, Windows and macOS hosts.

#### Scenario: Windows enrollment
- **WHEN** an operator enrolls a `windows` host
- **THEN** the API returns a PowerShell preflight command and a PowerShell install command
- **AND** the agent defaults to the native process backend on Windows
- **AND** the console enables the Windows platform option

#### Scenario: macOS enrollment
- **WHEN** an operator enrolls a `macos` host
- **THEN** the API returns a bash preflight command and a bash install command
- **AND** the agent defaults to the native process backend on macOS
- **AND** the console enables the macOS platform option

#### Scenario: Native execution
- **WHEN** a run is scheduled on a Windows or macOS host
- **THEN** the agent leases a native workspace, runs the harness and returns exec/artifact results
- **AND** no Temporal or Postgres credentials are present on the host

### Requirement: Remote artifact upload

The remote agent SHALL upload collected artifact blobs to the configured object store when
the control plane enables artifact storage.

#### Scenario: Upload after collection
- **WHEN** the worker sends `artifacts` for a remote run
- **THEN** the agent collects files, requests presigned PUT grants, uploads each blob and
  returns the object keys with the artifact metadata
- **AND** `patch.diff` content remains in the command result for downstream stages

#### Scenario: Upload failure
- **WHEN** an upload grant expires or a blob cannot be stored
- **THEN** the agent reports an upload error
- **AND** the run keeps its metadata and patch instead of losing evidence silently

### Requirement: Remote download

The console SHALL expose stored remote artifacts as download links after authorization.

#### Scenario: Stored artifact
- **WHEN** a run artifact has a `storageKey`
- **THEN** the run detail links to an authenticated download route
- **AND** the route returns a presigned GET or a local file
