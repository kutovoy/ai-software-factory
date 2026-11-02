# runner-sandbox Specification

## Purpose
Portable runner isolation with explicit failure when a requested sandbox is unavailable.

## Requirements

### Requirement: Sandbox selection

The runner SHALL choose a sandbox profile from configuration and platform.

#### Scenario: Linux bwrap
- **WHEN** `RUNNER_SANDBOX=bwrap` and `bwrap` is installed
- **THEN** commands run inside the bubblewrap jail with a writable workspace

#### Scenario: Missing bwrap
- **WHEN** `bwrap` is requested but absent
- **THEN** the run fails with `runner.sandbox_unavailable` rather than running unsandboxed

#### Scenario: macOS
- **WHEN** the platform is macOS and `sandbox-exec` is available
- **THEN** the existing profile is used

#### Scenario: Network denied
- **WHEN** the policy denies network
- **THEN** the jail unshares the network namespace
