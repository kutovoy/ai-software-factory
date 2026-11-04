# factory-loop Specification

## Purpose
Defines the factory loop: work items moving through a stage graph, orchestrated by a foreman, pausing at
durable gates, reviewed by a committee, with an autonomy policy and a kill switch.

## Requirements

### Requirement: Work item record

A work item SHALL be a persisted, typed record with a stable id, source context, lineage, and current stage.

#### Scenario: Creation from a source
- **WHEN** a work item is created from a forge label, a Slack mention, a cron trigger, or a manual prompt
- **THEN** it records `id`, `type`, `source`, `sourceRef`, `title`, `stage`, and `factory`
- **AND** `sourceRef` is enough to reply to the original thread/issue

#### Scenario: Lineage
- **WHEN** a stage spawns a follow-up work item (e.g. a flaky test found during verify)
- **THEN** the child records `parentId`
- **AND** the parent's event log records the spawn

#### Scenario: Stage transition is recorded
- **WHEN** a work item moves from `spec` to `implement`
- **THEN** a `stage.changed` event records `from`, `to`, `by` (`foreman` or a human), and reason

### Requirement: Stage graph

The loop SHALL compile an ordered stage graph from the factory definition and SHALL reject unknown stages or
cycles.

#### Scenario: Default graph
- **WHEN** the definition declares `stages: [triage, spec, plan, implement, review, verify, ship]`
- **THEN** the compiled graph has those nodes in order with `needs` edges
- **AND** `review` may fan out to multiple reviewer children

#### Scenario: Invalid graph
- **WHEN** the definition references an unknown stage or creates a cycle
- **THEN** validation fails with `invalid_stage_graph` naming the offending node

### Requirement: Foreman dispatch

The foreman SHALL decide the next stage and dispatch it to the agent configured for that stage, enforcing
`spawnableBy`.

#### Scenario: Dispatch
- **WHEN** a stage is ready
- **THEN** the foreman starts a child `StageWorkflow` with the agent, model/harness, runner and tools
  declared for that stage
- **AND** the child run pins the work item's `definitionCommit`

#### Scenario: Unauthorized spawn
- **WHEN** an agent attempts to dispatch an agent not in its `spawnableBy` list
- **THEN** dispatch fails with `spawn_not_allowed`
- **AND** the attempt is recorded

#### Scenario: Judgement call
- **WHEN** triage must classify a work item
- **THEN** the foreman agent is invoked with a schema-constrained output (`implement|spec|wait|reject`)
- **AND** an invalid response is retried, then escalated to a human gate

### Requirement: Durable gates with SLA

Every stage SHALL have a gate resolved from policy; a gate SHALL be a durable wait that does not consume
worker capacity.

#### Scenario: Human gate
- **WHEN** a stage resolves to `human`
- **THEN** the loop waits for `submitGateDecision` (Update) without holding an activity slot
- **AND** the decision is one of `approve|reject|request_changes`
- **AND** the decision, actor and timestamp are recorded

#### Scenario: Request changes
- **WHEN** a gate returns `request_changes`
- **THEN** the work item returns to the previous stage with the feedback attached
- **AND** the loop count increments; exceeding the configured limit escalates to a human

#### Scenario: SLA
- **WHEN** a gate is undecided past its SLA
- **THEN** an escalation event is emitted and the item appears in the inbox with age
- **AND** the configured fallback applies: auto-reject when lights-on, auto-approve only when the autonomy
  policy and benchmark gate allow it

#### Scenario: Agent gate
- **WHEN** a stage resolves to `agent`
- **THEN** the stage's own verifier/scorer verdict satisfies the gate
- **AND** the event log records the verdict and its evidence

### Requirement: Review committee

The `review` stage SHALL run at least two independent reviewers when configured, plus a judge, and SHALL
produce an advisory verdict only.

#### Scenario: Two reviewers
- **WHEN** `reviewers >= 2`
- **THEN** two reviewer children run independently on the same commit
- **AND** a judge merges their findings into `{verdict, findings[], confidence}`

#### Scenario: Disagreement
- **WHEN** reviewers disagree
- **THEN** the verdict is `needs_human` and the item escalates to the review gate
- **AND** both reports are attached

#### Scenario: No approval authority
- **WHEN** the committee returns `approve`
- **THEN** no merge is performed and no approval is posted to the forge
- **AND** the verdict is recorded as advisory

### Requirement: Autonomy policy and kill switch

The loop SHALL support full autonomy (all stages agent-gated) and SHALL expose a global kill switch.

#### Scenario: Lights-off
- **WHEN** every stage resolves to `agent` and `mergePolicy` allows unattended merge
- **THEN** the loop runs without human gates
- **AND** it records `benchmarkGateRequired` until Phase 4 benchmarks exist
- **AND** enabling autonomy is refused while that flag is unresolved and no override is recorded

#### Scenario: Kill switch
- **WHEN** autonomy is paused
- **THEN** new stage dispatch stops
- **AND** every gate resolves to `human`
- **AND** a `autonomy.paused` event records the actor

### Requirement: Forge abstraction

The loop SHALL interact with repositories only through a `CodeForge` interface, with a fake backend for
tests and demos.

#### Scenario: Branch and PR
- **WHEN** the implement stage completes
- **THEN** the forge creates a branch, commits the change, and opens a pull request referencing the work item
- **AND** the PR url is recorded on the work item

#### Scenario: Agents never push to main
- **WHEN** any stage attempts to write to the default branch
- **THEN** the forge rejects it with `protected_branch`
- **AND** the run fails with that code

#### Scenario: Fake backend
- **WHEN** the fake forge is used
- **THEN** it keeps an in-memory repo, PRs, comments and checks
- **AND** it can simulate red checks deterministically

### Requirement: Autonomy read model

The console SHALL read autonomy state from the API rather than deriving it from work-item events.

#### Scenario: Read
- **WHEN** `GET /autonomy?factory=` is called
- **THEN** it returns the declared policy, whether autonomy is enabled or paused, the last actor/reason/time
- **AND** it returns the newest `autonomy.*` event as evidence

#### Scenario: No state
- **WHEN** autonomy was never enabled
- **THEN** the response states `enabled: false` with a reason
- **AND** it does not invent a timestamp

### Requirement: Work-item cancellation

A work item SHALL be cancellable, idempotently and with an audit trail.

#### Scenario: Cancel
- **WHEN** `POST /work-items/:id/cancel` carries an actor and reason
- **THEN** the in-flight stage workflow is cancelled
- **AND** the item ends `cancelled` with a `work_item.cancelled` event

#### Scenario: Repeat
- **WHEN** cancel is called again
- **THEN** the same terminal state is returned
- **AND** no second event is emitted

#### Scenario: Terminal item
- **WHEN** the item is already done or failed
- **THEN** the request is refused with `invalid_state`

### Requirement: Automation attestation parity

Work items created by automations SHALL follow the same autonomy/attestation path as manual items.

#### Scenario: Missing attestation
- **WHEN** an automation creates a work item while autonomy requires a benchmark attestation
- **AND** no matching attestation exists
- **THEN** the item runs with human gates
- **AND** an `autonomy.attestation_missing` event records why (no silent downgrade)

### Requirement: Work-item retry

An escalated, failed or blocked work item SHALL be retryable without creating a duplicate item.

#### Scenario: Retry escalated
- **WHEN** `POST /api/v1/work-items/:id/retry` is called with actor and reason
- **THEN** the item returns to `active` at its current stage
- **AND** the stage is dispatched again under a new attempt workflow id
- **AND** a `work_item.retried` event records actor, reason and the previous status

#### Scenario: Not retryable
- **WHEN** the item is `active` or `done`
- **THEN** the request is refused with `work_item_not_retryable`
- **AND** the reason names the current status

#### Scenario: Idempotent
- **WHEN** retry is submitted twice within the dedupe window
- **THEN** the second call returns the existing dispatch
- **AND** no second workflow starts

#### Scenario: Cancelled item
- **WHEN** the item was cancelled and is retried
- **THEN** cancellation flags are cleared
- **AND** the audit keeps the prior cancellation as history

### Requirement: Intake sources

Work items SHALL accept the sources `forge`, `slack`, `cron`, `manual`, `sentry`, `posthog`,
`linear`, `jira` and `api`.

#### Scenario: Source persisted
- **WHEN** an intake provider creates a work item
- **THEN** its `source` is one of the allowed values
- **AND** the existing loop starts at the factory's first stage

### Requirement: Governance levels

The factory loop SHALL respect the declared autonomy level when deciding unattended actions.

#### Scenario: Full autonomy
- **WHEN** `autonomyLevel` is `full` and the kill switch is enabled
- **THEN** non-denied actions may proceed unattended

#### Scenario: Assist
- **WHEN** `autonomyLevel` is `assist`
- **THEN** unattended actions are denied and recorded for human follow-up
