# runner-protocol Specification

## Purpose
Defines how tool execution is isolated from the API: sandboxes are leased, commands run inside them, and
artifacts are collected by reference.

## Requirements

### Requirement: Sandbox leasing

The runner SHALL lease an isolated sandbox per run, mounting a checkout at the pinned definition commit,
and SHALL return a handle with a workspace path and harness endpoint.

#### Scenario: Lease
- **WHEN** a runner is leased for a run
- **THEN** a container starts with the repository checkout at the pinned commit
- **AND** the handle contains `runnerId`, `workspace`, `harnessUrl`
- **AND** the harness process is running inside the container

#### Scenario: Lease failure
- **WHEN** the container cannot start
- **THEN** the lease fails with code `runner_unavailable`
- **AND** the run ends with `status: error`

### Requirement: Tool execution isolation

All shell commands and harness tool calls SHALL execute inside the runner sandbox; the API process SHALL
NOT execute them.

#### Scenario: Command execution
- **WHEN** a setup or verification command is executed
- **THEN** it runs inside the container
- **AND** stdout/stderr/exit code are streamed back as events

#### Scenario: No host execution
- **WHEN** the API receives a request to run a command
- **THEN** it dispatches to the runner backend
- **AND** it never spawns a process on the API host

### Requirement: Secret boundary

Inference credentials SHALL NOT be present in the runner sandbox. Only explicitly granted execution
secrets SHALL be injected, by reference.

#### Scenario: Inference creds absent
- **WHEN** a runner container is inspected
- **THEN** no inference API key is present in its environment or filesystem

#### Scenario: Granted secret injected
- **WHEN** an agent grants secret `GITHUB_TOKEN`
- **THEN** only that secret is injected for the duration of the run
- **AND** it is never written to the event log

### Requirement: Inference access without credentials

Runners SHALL reach models only through an inference proxy that injects credentials outside the sandbox,
authenticates per run, and enforces an allowlist of models.

#### Scenario: Harness calls a model
- **WHEN** the harness inside the sandbox calls the OpenAI-compatible base URL
- **THEN** the request carries a per-run token, not a provider key
- **AND** the proxy injects the real credential and forwards the request
- **AND** the response streams back unchanged

#### Scenario: Model not allowed
- **WHEN** the harness requests a model outside the run's allowlist
- **THEN** the proxy returns 403 with code `model_not_allowed`
- **AND** the attempt is recorded in the event log

#### Scenario: Token expiry
- **WHEN** the run ends
- **THEN** its proxy token stops working immediately

### Requirement: Artifacts by reference

Artifacts SHALL be collected into the run directory and referenced by path and hash; blobs SHALL NOT be
stored in Postgres.

#### Scenario: Patch captured
- **WHEN** a run produces a git diff
- **THEN** `patch.diff` is written under the run directory
- **AND** the run record stores its path and sha256

#### Scenario: Cleanup
- **WHEN** a run reaches a terminal state
- **THEN** the sandbox is stopped and removed
- **AND** the run directory is retained

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
