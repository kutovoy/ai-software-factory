# Spec Delta

## Purpose

Defines how tool execution is isolated from the API: sandboxes are leased, commands run inside them, and
artifacts are collected by reference.

## ADDED Requirements

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
