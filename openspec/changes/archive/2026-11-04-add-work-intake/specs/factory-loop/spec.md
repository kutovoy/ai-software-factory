# Spec Delta

## ADDED Requirements

### Requirement: Intake sources

Work items SHALL accept the sources `forge`, `slack`, `cron`, `manual`, `sentry`, `posthog`,
`linear`, `jira` and `api`.

#### Scenario: Source persisted
- **WHEN** an intake provider creates a work item
- **THEN** its `source` is one of the allowed values
- **AND** the existing loop starts at the factory's first stage
