# Spec Delta

## ADDED Requirements

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
