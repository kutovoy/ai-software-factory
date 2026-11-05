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

### Requirement: Remote sandbox directory

A remote lease SHALL use an agent-local per-run sandbox directory, never the central host's run
directory.

#### Scenario: Remote lease without a run directory

- **WHEN** a remote lease has no run directory
- **THEN** the agent creates a temporary per-run sandbox directory
- **AND** the sandbox profile is written there instead of `/app/runs/...`
- **AND** the directory is removed on kill

### Requirement: macOS writable harness home

A macOS `sandbox-exec` lease SHALL provide a writable per-run HOME and XDG tree for harness state,
cache and session data, confined by the sandbox profile.

#### Scenario: opencode under sandbox-exec

- **WHEN** an opencode harness runs under a macOS `sandbox-exec` lease
- **THEN** `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` point
  inside the per-run sandbox home
- **AND** the profile allows writes there but not to the operator's real home
- **AND** the tree is removed on kill
