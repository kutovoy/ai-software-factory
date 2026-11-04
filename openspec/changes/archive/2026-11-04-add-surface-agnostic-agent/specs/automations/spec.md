# Spec Delta

## ADDED Requirements

### Requirement: CLI intake surface

The CLI SHALL be able to create work through the intake provider contract.

#### Scenario: Generic intake
- **WHEN** `factory intake --provider generic --title "..."` runs
- **THEN** it posts to `/api/v1/factories/:factoryId/intake/generic`
- **AND** prints the accepted/ignored status and work item id
