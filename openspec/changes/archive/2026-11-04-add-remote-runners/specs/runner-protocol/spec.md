# Spec Delta

## ADDED Requirements

### Requirement: Remote runner backend

The runner protocol SHALL support a `remote` backend that implements the same lease, exec,
heartbeat, artifact and kill contract over an agent command queue.

#### Scenario: Remote lease
- **WHEN** a run selects `runner: remote`
- **THEN** the worker leases a host, sends a `lease` command and receives a handle with
  `kind: remote`
- **AND** the harness runs on the remote host

#### Scenario: Remote command execution
- **WHEN** a setup or verification command runs on a remote lease
- **THEN** the agent executes it inside the sandbox
- **AND** stdout/stderr/exit are returned as exec events

#### Scenario: Remote artifacts
- **WHEN** artifacts are collected
- **THEN** the agent returns artifact metadata and `patch.diff` content
- **AND** the central worker writes them into the run directory

#### Scenario: Remote cleanup
- **WHEN** the run reaches a terminal state
- **THEN** the agent removes the sandbox
- **AND** the lease is released
