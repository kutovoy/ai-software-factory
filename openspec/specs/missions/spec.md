# missions Specification

## Purpose

Define the durable mission layer above work items: a pinned goal with a plan, milestones, features,
validation contract, checkpoints, events, gates, validations and optional budget. Missions plan before
code, gate the plan on human approval, execute features through the existing factory loop, validate each
milestone with fresh validators, turn actionable findings into fix features, and keep durable state outside
the model so long-running work can pause, resume, cancel or continue with bounded Temporal history.

## Requirements

### Requirement: Mission record

A mission SHALL be a persisted, owner-scoped record above work items with a stable id, goal, pinned
definition version, plan, status and budget.

#### Scenario: Creation
- **WHEN** a user creates a mission for a factory
- **THEN** it records `id`, `factory`, `factoryId`, `title`, `goal`, `status`, `definitionCommit`,
  `factoryRoot`, `createdBy` and timestamps
- **AND** it starts in `planning`

#### Scenario: Pinned definition
- **WHEN** the mission starts planning
- **THEN** every feature and validation run uses the mission's pinned definition commit
- **AND** a later factory definition change does not alter an in-flight mission

### Requirement: Mission plan and validation contract

A mission SHALL have a plan containing milestones, features, dependencies and a validation contract with
behavioral assertions.

#### Scenario: Plan before code
- **WHEN** planning completes
- **THEN** the validation contract is persisted before any feature work item starts
- **AND** every feature claims one or more contract assertions
- **AND** the plan is rejected if a dependency is unknown or the feature graph has a cycle

#### Scenario: Human approval
- **WHEN** a plan is proposed
- **THEN** the mission enters `awaiting_plan_approval`
- **AND** a human can approve, reject or request changes
- **AND** requesting changes re-plans with the feedback

### Requirement: Mission execution

A mission SHALL execute features through the existing factory loop and validate at milestone boundaries.

#### Scenario: Feature dispatch
- **WHEN** a feature is ready and its dependencies are done
- **THEN** the mission creates a work item linked to the mission and feature
- **AND** the work item starts at `implement`
- **AND** the mission waits for the work item to reach `done`

#### Scenario: Feature failure
- **WHEN** a feature work item is escalated, blocked or cancelled
- **THEN** the mission becomes `blocked`
- **AND** it records a precise blocker and waits for human intervention

#### Scenario: Milestone validation
- **WHEN** all features in a milestone are done
- **THEN** fresh scrutiny and user-testing validators run against the mission contract
- **AND** their evidence is persisted
- **AND** a failed validation creates fix features and re-validates
- **AND** exceeding the validation-round cap blocks the mission

### Requirement: Mission checkpoints and audit

A mission SHALL persist checkpoints and an append-only event log.

#### Scenario: Checkpoint
- **WHEN** a milestone or feature completes
- **THEN** a checkpoint records the current milestone/feature, completed work, decisions, failed approaches,
  test results, blockers and budget
- **AND** a new feature context can be rebuilt from the checkpoint without replaying the mission history

#### Scenario: Audit
- **WHEN** the plan is proposed/approved, a feature starts/completes/fails, validation passes/fails, a fix
  feature is created, or the mission is paused/resumed/cancelled/done
- **THEN** an append-only `mission_events` row records the transition

### Requirement: Mission control

A mission SHALL support plan approval, pause, resume, cancel and replan, with durable waits that do not hold
an activity slot.

#### Scenario: Pause
- **WHEN** a user pauses a running mission
- **THEN** no new feature is dispatched
- **AND** the in-flight feature child is cancelled
- **AND** the mission enters `paused`

#### Scenario: Cancel
- **WHEN** a user cancels a mission
- **THEN** exactly one cancellation event is recorded
- **AND** the mission enters `cancelled`

### Requirement: Mission budget

A mission SHALL enforce optional spend, run-count and wall-clock caps without bypassing factory quotas.

#### Scenario: Budget exhaustion
- **WHEN** a feature or validation would exceed the mission cap
- **THEN** admission refuses with `mission_budget_exhausted`
- **AND** the mission becomes `blocked`

### Requirement: Mission plan auto-approval

A mission plan SHALL be approved automatically when the factory is fully autonomous and the benchmark gate
is satisfied; otherwise it SHALL remain on the human plan gate.

#### Scenario: Full autonomy
- **WHEN** autonomy is enabled and not paused
- **AND** the factory declares `autonomyLevel: full`
- **AND** the benchmark gate is not required or is satisfied by a passing attestation or an audited override
- **THEN** the plan gate is decided `approve` without a human wait
- **AND** the `mission.plan.approved` event records an automatic actor and reason

#### Scenario: Any other factory
- **WHEN** autonomy is disabled/paused, the level is not `full`, or the benchmark gate is unsatisfied
- **THEN** the mission remains in `awaiting_plan_approval` until a human decides

### Requirement: Mission feature lifecycle

Mission feature work items SHALL run `implement`, `review` and `ship`, while `verify` SHALL be
performed at the milestone validation boundary.

#### Scenario: Partial feature
- **WHEN** a feature only adds part of a milestone (for example package metadata)
- **THEN** it is reviewed and shipped without the factory's whole-app verify gate
- **AND** the milestone's fresh scrutiny + user-testing validators check the integrated result

#### Scenario: Already satisfied feature
- **WHEN** a mission feature's implement run captures an empty patch because the integrated
  branch already satisfies it
- **THEN** the work item is marked done with a `work_item.no_changes` event and no PR
- **AND** regular work items still fail with `patch_missing` for an empty patch

#### Scenario: Runnable goal contract
- **WHEN** a goal asks for runnable software
- **THEN** the planner's validation contract includes an install/build assertion and an e2e
  assertion, not only static file checks

### Requirement: Risk-tiered plan approval

A mission plan SHALL carry a risk tier and reasons. Automatic approval SHALL be limited to low-risk plans
when autonomy is enabled/unpaused, `autonomyLevel` is `full`, and the benchmark gate is satisfied.

#### Scenario: Low-risk automatic approval
- **WHEN** a plan is `low` risk and the autonomy/benchmark conditions hold
- **THEN** the plan is approved automatically
- **AND** the approval event records the risk tier and reasons

#### Scenario: Medium or high risk
- **WHEN** a plan is `medium` or `high` risk
- **THEN** a human plan gate is required even under full autonomy

### Requirement: Mission plan design artifacts

A mission plan SHALL support product review, system architecture, program design and vertical-slice planning
before features are dispatched.

#### Scenario: Non-trivial goal
- **WHEN** the planner receives a non-trivial goal
- **THEN** the plan includes product review, architecture, program design and vertical slices
- **AND** the plan gate shows them before approval

#### Scenario: Existing plan
- **WHEN** a plan omits the optional artifacts
- **THEN** it remains valid and renders honest empty states

### Requirement: Vertical-slice features

Mission features SHALL declare the end-to-end behavior they deliver, or be marked as an enabler that states
which later slice verifies it.

#### Scenario: Horizontal plan
- **WHEN** a plan contains only horizontal scaffolding features
- **THEN** plan validation rejects it because it contains no vertical slice

#### Scenario: Enabler
- **WHEN** a feature is marked `enabler`
- **THEN** it states what it unblocks and which later slice verifies it

### Requirement: Plan depth and leverage

Mission plans SHALL carry `planDepth`, `expectedPain` and `leverage` so small changes stay light and
high-cost changes receive full upstream design.

#### Scenario: Small change
- **WHEN** a plan is low risk and reversible
- **THEN** it may use a light plan without full architecture/program-design sections

#### Scenario: High-cost change
- **WHEN** a plan touches data, schema or a high-risk path
- **THEN** it uses a full plan
- **AND** it waits for a human plan gate

### Requirement: Visual plan artifacts

Medium/high-risk UI plans SHALL reference at least one visual artifact (mockup, diagram or HTML page).

#### Scenario: UI plan
- **WHEN** a medium/high-risk plan changes a user-visible surface
- **THEN** the plan references a visual artifact
- **AND** Mission Control renders or links it

### Requirement: Experiment metadata

Mission plans SHALL carry optional experiment metadata: flag, success metric, guardrail and cleanup window.

#### Scenario: Experiment plan
- **WHEN** a plan includes an experiment
- **THEN** Mission Control shows the flag, metric, guardrail and cleanup window
- **AND** the plan gate records the experiment reference

### Requirement: Plan decision trail

Mission Control and work-item detail SHALL show a chronological decision trail from plan through gates,
review, PR and merge.

#### Scenario: Decision trail
- **WHEN** a work item has gate decisions, review verdicts and a PR
- **THEN** the detail page lists them in order with actor/reason
