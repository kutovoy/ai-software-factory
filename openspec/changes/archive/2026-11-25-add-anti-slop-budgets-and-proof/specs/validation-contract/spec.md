# Spec Delta

## ADDED Requirements

### Requirement: Proof evidence

Validation checks SHALL support an optional `artifactKind` and evidence SHALL carry optional artifact paths.
A required proof artifact SHALL be bound to the run and commit that produced it.

#### Scenario: Screenshot proof
- **WHEN** a UI assertion declares `artifactKind: screenshot` and the verify run produces a screenshot
- **THEN** the evidence records the artifact path
- **AND** the projection marks the check as complete

#### Scenario: Missing proof
- **WHEN** a required proof is absent
- **THEN** the check is `missing`
- **AND** the verify gate does not approve

### Requirement: Anti-slop checks

The validation builder SHALL infer a deterministic anti-slop/maintainability check when the repository
provides an `anti-slop` script.

#### Scenario: Anti-slop script
- **WHEN** `package.json` declares `anti-slop`, `lint:anti-slop` or `quality:anti-slop`
- **THEN** the contract includes a maintainability check with the script command
- **AND** a non-zero exit fails the verify gate
