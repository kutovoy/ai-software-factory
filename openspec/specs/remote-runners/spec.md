# remote-runners Specification

## Purpose
Remote runner hosts execute factory runs without Temporal, Postgres or provider credentials. A host enrolls from the console, exchanges a one-time token for a bearer agent token, heartbeats, and polls an outbound command queue. The central worker remains the scheduler and single event writer; the agent owns a Docker sandbox and the harness adapter and returns canonical events, artifact metadata, patch content and usage.

## Requirements

### Requirement: Runner enrollment

The API SHALL issue one-time enrollment tokens and exchange them for a per-host agent token.

#### Scenario: Create enrollment
- **WHEN** an authenticated user creates a runner enrollment with name, platform, arch, pool,
  labels and capacity
- **THEN** the API returns a one-time token, an expiry, a preflight command and an install
  command
- **AND** only the token hash is stored

#### Scenario: Exchange token
- **WHEN** an agent posts a valid, unused, unexpired token with host metadata
- **THEN** the API creates a `ready` host row and returns a random agent token once
- **AND** the enrollment is marked used
- **AND** a reused or expired token is refused with `enrollment_invalid`

#### Scenario: Preflight
- **WHEN** a preflight script posts platform checks for an enrollment token
- **THEN** the checks are stored on the enrollment
- **AND** the console can show pass/fail before installation

### Requirement: Agent command protocol

The agent SHALL poll an outbound command queue and execute `lease`, `exec`,
`start-session`, `pump`, `respond-permission`, `artifacts`, `cancel`, `kill` and
`smoke-test` commands without Temporal or Postgres access.

#### Scenario: Lease
- **WHEN** the central scheduler selects a host and enqueues a `lease` command
- **THEN** the agent creates or re-attaches to the deterministic sandbox
- **AND** returns the handle (`runnerId`, workspace, harness URL)

#### Scenario: Run session
- **WHEN** the central worker sends `start-session` with the prompt, agents, MCP wiring and
  proxy environment
- **THEN** the agent starts the harness adapter locally and sends the prompt
- **AND** returns the session reference and capabilities

#### Scenario: Pump
- **WHEN** the worker sends `pump` with `fromSeq`
- **THEN** the agent returns canonical events with a higher `seq`
- **AND** stops at a permission request, terminal event, cancellation or idle timeout

#### Scenario: Permission
- **WHEN** the worker sends `respond-permission`
- **THEN** the agent forwards the decision to the harness
- **AND** a missing request is a tolerated no-op

#### Scenario: Artifacts and cleanup
- **WHEN** the worker sends `artifacts`
- **THEN** the agent returns artifact metadata, `patch.diff` content and usage
- **WHEN** the worker sends `kill`
- **THEN** the sandbox is removed and the job forgotten
- **AND** repeated kills are no-ops

### Requirement: Central scheduling

The worker SHALL select a remote host by platform, pool, labels and free capacity, and
reserve a lease before sending work.

#### Scenario: Match
- **WHEN** a ready, non-draining host matches and has capacity
- **THEN** a lease is reserved and the run is dispatched

#### Scenario: No match
- **WHEN** no host matches
- **THEN** the run fails with `no_matching_runner`

#### Scenario: Expiry
- **WHEN** a command or lease exceeds its timeout
- **THEN** it is marked expired/released
- **AND** the activity fails with `runner_unavailable`

### Requirement: Provider-key boundary

Remote agents SHALL receive only the per-run inference proxy token and secret names, never
provider credentials.

#### Scenario: Harness environment
- **WHEN** a remote run starts
- **THEN** `harnessEnv` contains the proxy base URL and per-run token only
- **AND** `OPENAI_*` provider keys are absent from the agent payload

#### Scenario: Execution secret
- **WHEN** a run grants `GITHUB_TOKEN`
- **THEN** the payload carries the name only
- **AND** the agent resolves the value from its own environment

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

### Requirement: Remote checkout source

The worker SHALL send a remote lease exactly one checkout source: a clone URL, never the central
checkout path, and SHALL use `RUNNER_REPO_URL` when a work-item stage input has only a local path.

#### Scenario: Chat run

- **WHEN** a run uses `runner: remote` with a configured clone URL
- **THEN** the lease repo spec contains `url` and no `path`
- **AND** the lease reaches the agent instead of failing `invalid_spec`

#### Scenario: Work-item stage

- **WHEN** a work-item stage carries only the central repo path and `RUNNER_REPO_URL` is configured
- **THEN** the lease repo spec uses `RUNNER_REPO_URL` and the definition commit
- **AND** no central path is sent to the agent

### Requirement: Native harness provisioning

The worker SHALL include the runner opencode configuration in the harness command for opencode runs,
so native macOS/Windows agents resolve the factory provider without the runner Docker image.

#### Scenario: Native opencode run

- **WHEN** a remote opencode run starts on a native agent
- **THEN** the harness command carries `OPENCODE_CONFIG_CONTENT` with `factory/best_llm` and the
  per-run proxy environment templates
- **AND** the harness resolves the model instead of returning `ModelUnavailableError`

### Requirement: Remote network policy

Remote runs SHALL grant sandbox network access so the harness can reach the per-run inference proxy
and the artifact store; the remote host's egress allowlist remains the boundary.

#### Scenario: Remote lease

- **WHEN** the worker leases a sandbox for `runner: remote`
- **THEN** the lease carries `networkPolicy: allowed`
- **AND** a macOS `sandbox-exec` profile allows outbound network while keeping local writes confined

### Requirement: Terminal-status fallback

The agent SHALL close a run when a quiet pump window finds the harness session terminal, even if the
terminal event was emitted before the adapter subscribed.

#### Scenario: Failed-before-subscribe session

- **WHEN** a pump window ends idle and the harness reports `outcome: failed`
- **THEN** the agent returns a terminal `error` result with the provider error summary
- **AND** the run does not stay `running` indefinitely

### Requirement: Agent shutdown cleanup

The agent SHALL kill live harness sessions and sandboxes when it shuts down.

#### Scenario: SIGTERM during a run

- **WHEN** the agent receives SIGTERM while a job is active
- **THEN** it stops the harness adapter, kills the sandbox and exits
- **AND** no harness child or runner container is left behind

### Requirement: Remote pump liveness

The worker SHALL keep a remote pump activity alive while it waits for an agent command and
SHALL allow enough time for a command queued behind concurrent stage runs.

#### Scenario: Concurrent review
- **WHEN** two review runs on one remote host queue pump commands behind each other
- **THEN** the worker heartbeats while waiting
- **AND** the pump command is not killed by `activity Heartbeat timeout` before the agent
  answers

#### Scenario: Queue delay
- **WHEN** a remote pump command waits in the agent's serial command queue
- **THEN** the worker allows at least 120 seconds for the command
- **AND** a genuine missing command still surfaces a timeout
