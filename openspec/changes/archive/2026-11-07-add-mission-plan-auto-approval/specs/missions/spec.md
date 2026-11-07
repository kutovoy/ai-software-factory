# Spec Delta

## ADDED Requirements

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
