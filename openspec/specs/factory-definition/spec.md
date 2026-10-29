# factory-definition Specification

## Purpose
Defines the factory as a declarative, git-versioned artifact: its schema, resource layout, validation
rules, gate/merge-policy resolution, version pinning, and lossless export/import/diff round-trip.

## Requirements

### Requirement: Definition layout and path identity

A factory definition SHALL consist of a root `factory.yaml` plus resource documents addressed by path.
The resource name SHALL be derived from its path, and SHALL NOT be duplicated in frontmatter.

#### Scenario: Valid layout
- **WHEN** a directory contains `factory.yaml`, `agents/reviewer/agent.md`, `automations/nightly/automation.md`,
  `scorers/scope/scorer.md`, `benchmarks/review/suite.yaml`, and `skills/conventions/SKILL.md`
- **THEN** the loader reports resources named `reviewer`, `nightly`, `scope`, `review`, `conventions`
- **AND** validation succeeds

#### Scenario: Duplicate identity
- **WHEN** two files resolve to the same resource kind and name
- **THEN** validation fails with an error naming both paths

#### Scenario: Unknown file
- **WHEN** a file exists outside the allowed resource directories
- **THEN** validation fails with the path and the list of allowed locations

### Requirement: Root manifest schema

`factory.yaml` SHALL validate against a versioned schema and SHALL declare `schemaVersion`, `name`,
`repositories`, `agentDefaults`, `gates`, and `mergePolicy`.

#### Scenario: Missing schema version
- **WHEN** `factory.yaml` omits `schemaVersion`
- **THEN** validation fails with an error identifying the missing field and the supported versions

#### Scenario: Unsupported schema version
- **WHEN** `schemaVersion` is not a supported value
- **THEN** validation fails with a migration hint naming the supported versions

#### Scenario: Repository declaration
- **WHEN** `repositories` is empty or a repository lacks `owner` or `name`
- **THEN** validation fails with the offending entry and JSON pointer

### Requirement: Inference selection is exclusive

Any document that selects inference SHALL declare exactly one of `model` or `harness`.

#### Scenario: Both declared
- **WHEN** an agent declares both `model` and `harness`
- **THEN** validation fails explaining they are mutually exclusive

#### Scenario: Neither declared at defaults
- **WHEN** `agentDefaults` declares neither `model` nor `harness`
- **THEN** validation fails and names the two allowed shapes

#### Scenario: Harness auth reference
- **WHEN** `harness.auth.source` is `managedSecret`
- **THEN** `secretName` is required
- **AND** the referenced secret SHALL exist in the factory's `secrets` list

### Requirement: Gate and merge policy resolution

The system SHALL resolve, for every stage, whether a human or an agent approves it, using the precedence
`automation override → factory gates → global default`, and SHALL expose the merge policy separately.

#### Scenario: Factory default applies
- **WHEN** an automation does not override a stage gate and the factory declares `gates.review: human`
- **THEN** the resolved gate for that stage is `human`

#### Scenario: Automation override wins
- **WHEN** an automation declares `gates.review: agent` and the factory declares `human`
- **THEN** the resolved gate is `agent`

#### Scenario: Lights-off resolution
- **WHEN** every stage resolves to `agent` and `mergePolicy` is `auto_on_green`
- **THEN** the resolver reports the factory as fully autonomous
- **AND** reports that a benchmark gate is required before autonomy may be enabled

#### Scenario: Invalid gate value
- **WHEN** a gate value is not `human`, `agent`, or `policy:<name>`
- **THEN** validation fails listing the allowed values

### Requirement: Lossless round-trip

`export` SHALL write canonical files and `import` SHALL read them back such that a second `export`
produces byte-identical output.

#### Scenario: Reference factory round-trip
- **WHEN** `factory export factories/example --out /tmp/a` then `factory import /tmp/a` then
  `factory export --out /tmp/b` are run
- **THEN** the file trees under `/tmp/a` and `/tmp/b` are identical byte-for-byte

#### Scenario: Canonical formatting is stable
- **WHEN** a definition is exported twice from the same in-memory document
- **THEN** both outputs are identical
- **AND** YAML keys are sorted and indentation is two spaces

### Requirement: Semantic diff

`diff` SHALL compare two definition trees semantically and report added, removed, and changed resources
with field-level paths.

#### Scenario: Field change
- **WHEN** an agent's `harness.model` changes between two versions
- **THEN** the diff reports resource `agent:reviewer`, field `harness.model`, old and new values

#### Scenario: Resource removal
- **WHEN** a scorer file is deleted between versions
- **THEN** the diff reports the resource as removed and exits non-zero in `--exit-code` mode

### Requirement: Version pinning

A definition version SHALL be identified by a git commit SHA and MAY carry a `factory-vN` tag. Runs,
scores and benchmarks SHALL record the version they executed against.

#### Scenario: Version record
- **WHEN** a version is created from a clean git worktree
- **THEN** it records `commit`, optional `tag`, and a content hash of the definition tree
- **AND** the same tree always yields the same content hash regardless of file order

#### Scenario: Dirty worktree
- **WHEN** the worktree has uncommitted definition changes
- **THEN** version creation fails unless `--allow-dirty` is passed, in which case the version is marked dirty

### Requirement: Actionable validation errors

Every validation failure SHALL include the file path, a JSON pointer to the offending value, a human
message, and a stable machine code.

#### Scenario: Error shape
- **WHEN** validation fails on an invalid `samplingRate`
- **THEN** the error contains `code`, `file`, `pointer`, and `message`
- **AND** the CLI prints them in that order
- **AND** `--json` emits an array of such objects

### Requirement: Improvement authority configuration

`factory.yaml` SHALL declare an `improvement` block with an authority level, and the value SHALL be validated
against the supported levels.

#### Scenario: Valid authority
- **WHEN** `improvement.authority` is one of `propose_only`, `auto_merge_on_benchmark`, `canary`
- **THEN** the definition validates

#### Scenario: Invalid authority
- **WHEN** `improvement.authority` is any other value
- **THEN** validation fails with `invalid_value` naming the field and allowed values

#### Scenario: Default
- **WHEN** the `improvement` block is omitted
- **THEN** the authority defaults to `propose_only`
- **AND** the resolved configuration reports the default explicitly

#### Scenario: Canary requires parameters
- **WHEN** authority is `canary`
- **THEN** `improvement.canaryPercent` (1–100) and `improvement.rollbackThreshold` are required
- **AND** validation fails with `missing_field` otherwise
