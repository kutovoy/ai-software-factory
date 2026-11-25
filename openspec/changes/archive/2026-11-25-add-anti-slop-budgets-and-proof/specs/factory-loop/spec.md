# Spec Delta

## ADDED Requirements

### Requirement: Slop stop conditions

A work item SHALL measure deterministic slop metrics after implementation and SHALL stop or escalate when
the risk-tiered budget is exceeded.

#### Scenario: Agent review overage
- **WHEN** an agent-gated review stage exceeds the budget
- **THEN** the gate resolves `request_changes`
- **AND** the feedback names the exceeded metrics

#### Scenario: Human review overage
- **WHEN** a human review gate exceeds the budget
- **THEN** the packet shows the overage
- **AND** approval requires an explicit waiver reason

### Requirement: Context pack

Every feature/work item SHALL receive a deterministic context pack before implementation.

#### Scenario: Pack contents
- **WHEN** a stage prompt is built
- **THEN** it includes relevant ADRs, architecture constraints, prior failures/PRs and test standards
- **AND** the pack is bounded and records its sources

### Requirement: Review packet v2

A review packet SHALL include budget vs actual, blast radius, proof artifacts, a deterministic read-first
list, decisions, reviewer roles and comprehension estimates.

#### Scenario: High-risk packet
- **WHEN** a high-risk work item reaches review
- **THEN** the packet lists high-risk paths, proof and the reviewer roles
- **AND** the human gate shows the packet before a decision
