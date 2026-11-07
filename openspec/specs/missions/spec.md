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
