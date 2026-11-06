# Spec Delta

## MODIFIED Requirements

### Requirement: Promotion hook

Promotion SHALL apply the candidate to the local checkout or record that it is pending.

#### Scenario: Clean checkout
- **WHEN** a canary is promoted and the factory path is clean in a git worktree
- **THEN** the candidate definition is written to the local factory tree
- **AND** a local commit records the promotion
- **AND** the rollout records `deployed` with the checkout commit

#### Scenario: Dirty checkout
- **WHEN** the factory path has uncommitted changes
- **THEN** promotion does not overwrite them
- **AND** the rollout records `promotion_pending_deploy` with the reason

#### Scenario: Hook configured
- **WHEN** a factory declares a `deployHook`
- **THEN** promotion runs it after the merge and local rewrite
- **AND** a failure marks the rollout `promoted_pending_deploy` with the error

#### Scenario: No hook
- **WHEN** no hook is configured and the local checkout cannot be updated
- **THEN** promotion records `promotion_pending_deploy`
- **AND** it does not claim the checkout was updated
