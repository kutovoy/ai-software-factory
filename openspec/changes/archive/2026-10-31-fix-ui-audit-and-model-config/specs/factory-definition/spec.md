# Spec Delta

## ADDED Requirements

### Requirement: Model references

A model MAY be declared as an environment reference (`env:NAME`) instead of a literal, and the resolved
configuration SHALL report both forms.

#### Scenario: Resolved reference
- **WHEN** a harness declares `model: env:FACTORY_MODEL` and `FACTORY_MODEL` is set
- **THEN** the resolved config reports `ref: env:FACTORY_MODEL` and `value: <the env value>`
- **AND** runs use the resolved value

#### Scenario: Unset reference
- **WHEN** the referenced variable is unset
- **THEN** loading succeeds with a warning `model_env_unresolved` naming the variable
- **AND** starting a run with an unresolved model fails with `model_unresolved` rather than sending a literal
  `env:...` string upstream

#### Scenario: Literal unchanged
- **WHEN** a model is a literal string
- **THEN** it is used verbatim
- **AND** no environment lookup happens

#### Scenario: Invalid reference
- **WHEN** a model starts with `env:` but has no valid variable name
- **THEN** validation fails with `invalid_value` naming the field
