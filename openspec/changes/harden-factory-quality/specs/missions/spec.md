# Spec Delta

## ADDED Requirements

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
