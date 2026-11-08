# Spec Delta

## ADDED Requirements

### Requirement: Plan design review

Mission Control SHALL show product review, architecture, program design and vertical slices before plan
approval, with honest empty states when a small plan omits them.

#### Scenario: Plan gate
- **WHEN** a plan is awaiting approval
- **THEN** the plan gate shows the design artifacts, risk tier and reasons
- **AND** a high-risk plan cannot be approved automatically

### Requirement: Review packet and risk gates

Work-item detail and Inbox SHALL show a compact review packet, and high-risk work items SHALL require a
human review decision before ship.

#### Scenario: High-risk work item
- **WHEN** a work item is `high` risk
- **THEN** the UI shows the review packet and a human review gate
- **AND** the item cannot auto-merge

#### Scenario: Low-risk work item
- **WHEN** a work item is `low` risk and verification is green
- **THEN** the UI may show the packet without blocking auto-merge
