# Spec Delta

## ADDED Requirements

### Requirement: Risk-aware routing

Routing SHALL consider the work item's risk tier. High-risk work SHALL use the deep inference tier even when
the prompt score is lower.

#### Scenario: High risk
- **WHEN** a high-risk work item is routed
- **THEN** the deep tier is selected
- **AND** the reason records the risk tier

#### Scenario: Low risk
- **WHEN** a low-risk work item is routed
- **THEN** the existing score-based tier selection applies

### Requirement: Standards stop condition

A review packet SHALL record public API/schema standards vs actual, and an exceeded standard SHALL stop an
agent review gate.

#### Scenario: Exceeded standard
- **WHEN** public API or schema changes exceed the configured cap
- **THEN** the packet reports `standards.status: exceeded`
- **AND** an agent review gate resolves `request_changes`

#### Scenario: Human gate
- **WHEN** a human review gate has an exceeded standard
- **THEN** the packet shows the counts
- **AND** approval requires an explicit waiver reason
