# Spec Delta

## ADDED Requirements

### Requirement: Review capacity configuration

Factory definitions SHALL declare optional `quality.reviewCapacity` caps for open gates, unread diff lines,
gate age and review hours per week. Existing definitions SHALL validate with defaults.

#### Scenario: Default capacity
- **WHEN** a factory omits `quality.reviewCapacity`
- **THEN** the resolver reports the shipped defaults
- **AND** the factory remains valid

#### Scenario: Saturated factory
- **WHEN** pending gates or unread diff lines exceed the configured caps
- **THEN** the factory is reported saturated
- **AND** full autonomy/plan auto-approval requires an explicit override

### Requirement: Experiment configuration

Factory definitions SHALL declare an optional experiment provider, project-key secret reference and flag
prefix.

#### Scenario: Experiment config
- **WHEN** a factory declares `experiments.provider: posthog`
- **THEN** the manifest validates
- **AND** the secret reference is resolved by name only
