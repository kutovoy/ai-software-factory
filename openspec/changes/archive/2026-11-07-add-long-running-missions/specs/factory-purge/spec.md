# Spec Delta

## ADDED Requirements

### Requirement: Mission purge

Factory purge SHALL delete missions and all mission children and verify none survive.

#### Scenario: Purge
- **WHEN** a factory is purged
- **THEN** `missions`, `mission_milestones`, `mission_features`, `mission_checkpoints`, `mission_events`,
  `mission_gates` and `mission_validations` for that factory are deleted
- **AND** work-item/run mission links are cleared or deleted with their parents
- **AND** the purge verification fails if any mission row survives
