# Spec Delta

## ADDED Requirements

### Requirement: Mission quotas

A mission SHALL enforce optional spend, run-count and wall-clock caps in addition to factory quotas.

#### Scenario: Admission
- **WHEN** a feature or validation run would exceed a mission cap
- **THEN** admission refuses with `mission_budget_exhausted`
- **AND** the mission becomes `blocked`
- **AND** factory budget/quota errors keep their existing codes
