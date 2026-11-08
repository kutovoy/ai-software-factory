# Spec Delta

## ADDED Requirements

### Requirement: Risk-tiered autonomy

Factory definitions SHALL declare per-risk-tier plan approval, review and merge policy, plus high-risk path
rules, so autonomy is bounded by blast radius and verification capacity.

#### Scenario: Low-risk loop
- **WHEN** a change is classified `low` risk
- **THEN** the factory MAY auto-approve the plan and auto-merge on green when autonomy and the benchmark gate
  allow it

#### Scenario: High-risk change
- **WHEN** a change touches a configured high-risk path or is classified `high`
- **THEN** a human plan gate and a human review gate are required
- **AND** the change MUST NOT auto-merge

#### Scenario: Existing definitions
- **WHEN** a factory definition omits the risk block
- **THEN** it validates with conservative defaults
