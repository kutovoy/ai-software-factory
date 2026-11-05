# Spec Delta

## ADDED Requirements

### Requirement: Native process backend

The runner protocol SHALL support a native process backend on Windows and macOS in addition
to the existing Docker and Linux local backends.

#### Scenario: Windows process
- **WHEN** the Windows backend leases a run
- **THEN** it creates a workspace, starts the harness through PowerShell and returns a handle
- **AND** exec, heartbeat, artifacts and kill use the same protocol as other backends

#### Scenario: macOS process
- **WHEN** the macOS backend leases a run
- **THEN** it creates a workspace and starts the harness through the host shell
- **AND** `sandbox-exec` is used when requested and available

### Requirement: Artifact storage metadata

Artifact metadata SHALL be able to carry an object-store key without changing the existing
path/bytes/sha256/kind contract.

#### Scenario: Stored artifact
- **WHEN** an artifact is uploaded to object storage
- **THEN** its metadata includes `storageKey` and `bucket`
- **AND** existing consumers that only read `path`, `bytes`, `sha256` and `kind` keep working
