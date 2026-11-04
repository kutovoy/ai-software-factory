# Spec Delta

## ADDED Requirements

### Requirement: Governance levels

The factory loop SHALL respect the declared autonomy level when deciding unattended actions.

#### Scenario: Full autonomy
- **WHEN** `autonomyLevel` is `full` and the kill switch is enabled
- **THEN** non-denied actions may proceed unattended

#### Scenario: Assist
- **WHEN** `autonomyLevel` is `assist`
- **THEN** unattended actions are denied and recorded for human follow-up
