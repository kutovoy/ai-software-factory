# Spec Delta

## ADDED Requirements

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
