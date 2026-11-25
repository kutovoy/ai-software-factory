# Spec Delta

## ADDED Requirements

### Requirement: Standards configuration

Factory definitions SHALL declare optional `quality.standards` caps for public API and schema changes.

#### Scenario: Default standards
- **WHEN** a factory omits `quality.standards`
- **THEN** the resolver reports the shipped defaults
- **AND** the factory remains valid

#### Scenario: Override
- **WHEN** a factory declares a partial `quality.standards`
- **THEN** missing fields inherit the defaults
