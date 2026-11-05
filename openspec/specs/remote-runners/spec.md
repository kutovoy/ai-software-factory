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
