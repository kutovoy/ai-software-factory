# Spec Delta

## ADDED Requirements

### Requirement: Work-item runner override

A work item's explicit `runner` SHALL override the compiled stage node's runner for every
stage, while the fake harness still uses the ephemeral fake runner.

#### Scenario: Remote override
- **WHEN** a work item is created with `runner: remote`
- **THEN** every stage child run uses `remote`
- **AND** the stage node's declared runner does not silently replace it

#### Scenario: Retry
- **WHEN** an item created with a runner override is retried
- **THEN** the retry snapshot keeps the same runner override

#### Scenario: No override
- **WHEN** a work item has no explicit runner
- **THEN** the compiled stage node runner is used
- **AND** the factory default remains the final fallback
