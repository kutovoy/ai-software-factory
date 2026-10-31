# Spec Delta

## ADDED Requirements

### Requirement: Consistent factory heading

Every factory page SHALL render the factory heading from one source (alias, falling back to the directory
name), and two factories SHALL be distinguishable.

#### Scenario: Same heading everywhere
- **WHEN** any factory page renders
- **THEN** the heading prefix is identical across Dashboard, Agents, Automations, Benchmarks, Definition,
  Gates, Merge queue, Scorers, Self-improvement and Settings

#### Scenario: Distinct factories
- **WHEN** two factories are loaded
- **THEN** their aliases differ
- **AND** the switcher and headings identify which one is open

### Requirement: Truthful status copy

Status text SHALL describe the state it is rendered from.

#### Scenario: Attestation not required
- **WHEN** a benchmark attestation is not required because human gates remain
- **THEN** the copy says so
- **AND** it does not claim an attestation matches the version

#### Scenario: Canary configured
- **WHEN** the authority is `canary` but no rollout is active
- **THEN** the copy says the authority is enabled
- **AND** active-rollout state is reported separately

### Requirement: No horizontal overflow

Pages SHALL fit the viewport at 1280px, and long unbroken values SHALL wrap or scroll inside their card.

#### Scenario: Long config value
- **WHEN** a resolved configuration contains a long unbroken string
- **THEN** the page does not scroll horizontally
- **AND** the value remains readable

### Requirement: Attributable references

Secret references SHALL name the factory they come from, so identical references in two factories are not
shown as duplicates.

#### Scenario: Same name, two factories
- **WHEN** two factories reference the same secret at the same pointer
- **THEN** the list shows one row per factory
- **AND** each row names its factory

### Requirement: Pluralisation

Counts SHALL be rendered with correct singular/plural forms.

#### Scenario: One server
- **WHEN** a factory declares one MCP server
- **THEN** the label reads `1 server`, not `1 servers`
