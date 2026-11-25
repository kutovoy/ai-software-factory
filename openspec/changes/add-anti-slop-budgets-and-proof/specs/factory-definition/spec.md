# Spec Delta

## ADDED Requirements

### Requirement: Quality budgets

Factory definitions SHALL declare an optional `quality.slopBudget` block with per-risk-tier limits for diff
lines, changed files, new dependencies, duplication delta and complexity delta. Existing definitions SHALL
validate with conservative defaults.

#### Scenario: Default budgets
- **WHEN** a factory omits `quality.slopBudget`
- **THEN** the resolver reports the low/medium/high defaults
- **AND** the factory remains valid

#### Scenario: Override
- **WHEN** a factory declares a partial `quality.slopBudget`
- **THEN** missing tier fields inherit the defaults
- **AND** the resolved budget is recorded on the work item/review packet

### Requirement: Proof requirements

Factory definitions SHALL declare optional proof requirements for UI/behavioral changes, including accepted
artifact kinds.

#### Scenario: UI change without proof
- **WHEN** `quality.proof.requireForUi` is true and a UI/behavioral assertion has no proof artifact
- **THEN** the validation projection is incomplete
- **AND** the verify gate refuses approval
