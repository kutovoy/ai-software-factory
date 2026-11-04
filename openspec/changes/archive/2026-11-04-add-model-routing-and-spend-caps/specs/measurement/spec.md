# Spec Delta

## ADDED Requirements

### Requirement: Budget measurement

Factory metrics and run records SHALL expose spend against configured caps.

#### Scenario: Cost attribution
- **WHEN** a factory has a budget
- **THEN** recorded run cost remains attributable per stage
- **AND** the budget endpoint reports the same recorded spend used by the factory cap

#### Scenario: Exhausted work
- **WHEN** the factory cap is reached
- **THEN** new work is refused before a run is created
- **AND** no zero-cost run is fabricated
