# Spec Delta

## ADDED Requirements

### Requirement: Local sandbox profile

The local runner SHALL confine the harness process to the workspace when a sandbox profile is available.

#### Scenario: Sandboxed run
- **WHEN** the local backend runs with `RUNNER_SANDBOX=exec` on macOS
- **THEN** the harness runs under `sandbox-exec` with a generated profile
- **AND** it may read system paths and the workspace
- **AND** it may write only the workspace, `/private/tmp` and the run directory
- **AND** network access is denied unless the factory grants it

#### Scenario: Network granted
- **WHEN** the factory grants network to the stage
- **THEN** the profile allows outbound network
- **AND** the grant is recorded on the run

#### Scenario: Escape attempt
- **WHEN** the harness writes outside the allowed paths
- **THEN** the write fails at the OS level
- **AND** the failure surfaces as a tool error, not a crashed run

#### Scenario: Unsupported platform
- **WHEN** the platform has no sandbox backend
- **THEN** the run proceeds without confinement
- **AND** a `runner.sandbox_unavailable` event states that explicitly
