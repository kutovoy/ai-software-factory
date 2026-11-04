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

### Requirement: Validation block

`factory.yaml` SHALL accept an optional `validation` block.

#### Scenario: Shape
- **WHEN** a factory declares `validation`
- **THEN** it may declare `enabled`, `enforce`, `tiers` and `checks`
- **AND** each check has `id`, `title`, `tier`, `required`, `evidence` and optional `command`
- **AND** invalid tiers or empty check ids fail validation with a stable code

#### Scenario: Defaults
- **WHEN** the block is absent
- **THEN** validation is enabled and enforcement is off
- **AND** checks are inferred at work-item creation

### Requirement: Readiness block

`factory.yaml` SHALL accept an optional `readiness` block.

#### Scenario: Shape
- **WHEN** a factory declares `readiness`
- **THEN** it may declare `enforceAutonomy` and `thresholds.ready` / `thresholds.warn`
- **AND** thresholds are integers between 0 and 100 with `warn <= ready`

#### Scenario: Defaults
- **WHEN** the block is absent
- **THEN** readiness is advisory only
- **AND** the default thresholds are 80 and 60

### Requirement: Guard block

`factory.yaml` SHALL accept an optional `guard` block.

#### Scenario: Shape
- **WHEN** a factory declares `guard`
- **THEN** it may declare `enabled`, `secretScan`, `protectedBranches`, `maxChangedFiles`, `maxPatchBytes` and `binaryFileLimit`
- **AND** limits are positive integers

#### Scenario: Defaults
- **WHEN** the block is absent
- **THEN** guard hooks are enabled with the default protected branches `main` and `master`
- **AND** the default limits are finite and documented

### Requirement: Classifier routing

`routing.yaml` SHALL support an optional `classifier` block with `cheap`, `standard` and
`deep` tiers. When enabled, a deterministic classifier SHALL select a tier from the task
prompt and stage.

#### Scenario: Cheap task
- **WHEN** a triage or small documentation task is classified
- **THEN** the cheap tier's inference is selected

#### Scenario: Deep task
- **WHEN** a review or a prompt containing security/migration/architecture terms is classified
- **THEN** the deep tier's inference is selected

#### Scenario: Disabled classifier
- **WHEN** `classifier.enabled` is false
- **THEN** `stages[stage]` then `default` are used
- **AND** an absent route keeps the agent/default model

### Requirement: Spend caps

`factory.yaml` SHALL support optional `budget.maxCostUsdPerRun`,
`budget.maxCostUsdPerStage` and `budget.maxCostUsdPerFactory`.

#### Scenario: Per-run cap
- **WHEN** a run's accumulated `usage.updated.costUsd` exceeds its cap
- **THEN** the run stops with `budget_exhausted`
- **AND** the run is recorded as an error

#### Scenario: Per-stage cap
- **WHEN** a stage declares a stage cap
- **THEN** that cap applies to the stage run instead of the run cap

#### Scenario: Factory cap
- **WHEN** a factory's recorded spend reaches `maxCostUsdPerFactory`
- **THEN** new work items/runs are refused with `factory_budget_exhausted`
- **AND** existing runs are not retroactively failed

#### Scenario: Budget status
- **WHEN** `GET /api/v1/factories/:factoryId/budget` is requested
- **THEN** it returns the configured caps, recorded spend and exhaustion state

### Requirement: Governance policy

Factories MAY declare `governance` with an autonomy level, model allowlist, deny actions,
human-required actions and audit export.

#### Scenario: Denied action
- **WHEN** an unattended run requests an action matching `denyActions`
- **THEN** the action is denied
- **AND** a `policy` run step records the decision and reason

#### Scenario: Human-required action
- **WHEN** an unattended run requests an action matching `requireHumanActions`
- **THEN** the action is denied
- **AND** the decision is recorded

#### Scenario: Observe/assist
- **WHEN** `autonomyLevel` is `observe` or `assist`
- **THEN** unattended actions require a human and are denied in a factory run

#### Scenario: Model allowlist
- **WHEN** a resolved model is outside `allowedModels`
- **THEN** work-item/run creation fails with `model_not_allowed`
- **AND** no run is started

### Requirement: Governance audit

Policy decisions SHALL be queryable per factory.

#### Scenario: Read
- **WHEN** `GET /api/v1/factories/:factoryId/governance` is requested
- **THEN** it returns the governance config, live autonomy state and recent decisions

#### Scenario: Export
- **WHEN** `/governance/audit` is requested
- **THEN** it returns the configured export mode and the decisions
