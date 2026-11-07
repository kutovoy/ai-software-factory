# Spec Delta

## ADDED Requirements

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
