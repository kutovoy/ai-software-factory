# Spec Delta

## ADDED Requirements

### Requirement: Mission validation contract

A mission SHALL have a validation contract written before features are defined, with behavioral assertions,
required flags, tools and expected evidence.

#### Scenario: Contract evaluation
- **WHEN** a milestone validator reports evidence
- **THEN** the contract is evaluated by assertion id
- **AND** missing required assertions make the milestone fail
- **AND** the evidence and findings are persisted

#### Scenario: Fix features
- **WHEN** a required assertion fails
- **THEN** the orchestrator creates fix features targeting the failing assertions
- **AND** validators do not implement fixes
