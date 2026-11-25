# Spec Delta

## ADDED Requirements

### Requirement: Review-capacity backpressure

Mission plan auto-approval SHALL refuse when the factory's review capacity is saturated.

#### Scenario: Saturated review queue
- **WHEN** open gates or unread diff lines exceed the configured capacity
- **THEN** auto-approval returns false with `review_capacity_exceeded`
- **AND** the reason names the exceeded cap

#### Scenario: Capacity available
- **WHEN** capacity is within bounds and the other autonomy conditions hold
- **THEN** a low-risk plan may auto-approve

### Requirement: Decision-linked pull requests

Pull request bodies SHALL link the work item, plan reference, risk tier, context pack and review packet so a
reviewer can reconstruct intent and evidence without leaving the forge.

#### Scenario: PR body
- **WHEN** a pull request is opened
- **THEN** the body names the work item and plan reference
- **AND** it names the risk tier, context pack and review-packet reference
