# harness-adapter Specification

## Purpose
Defines the harness-agnostic contract that turns any agent harness into a source of canonical factory
events, with explicit capability negotiation.

## Requirements

### Requirement: Canonical event union

Every adapter SHALL emit events conforming to a single canonical union: `run.started`, `message.delta`,
`message.completed`, `tool.call.started`, `tool.call.args.delta`, `tool.call.completed`,
`permission.requested`, `file.edited`, `artifact.produced`, `usage.updated`, `run.completed`.

#### Scenario: Unknown harness payload
- **WHEN** a harness emits a payload with no canonical mapping
- **THEN** the adapter drops it and increments a `droppedEvents` counter
- **AND** the run does not fail

#### Scenario: Ordering
- **WHEN** events are emitted for a run
- **THEN** each event carries a strictly increasing `seq` per run

### Requirement: Capability negotiation

Adapters SHALL declare capabilities (`streaming`, `toolCalls`, `permissions`, `resume`, `fork`, `usage`,
`structuredOutput`) and consumers SHALL degrade gracefully.

#### Scenario: Static permissions
- **WHEN** an adapter declares `permissions: "static"`
- **THEN** the API does not expose a permission decision endpoint for that run
- **AND** the UI is told permissions are not interactive

#### Scenario: No resume support
- **WHEN** an adapter declares `resume: false`
- **THEN** a resumed run starts a fresh session and records that resume was unavailable

### Requirement: Permission round-trip

Adapters supporting interactive permissions SHALL emit `permission.requested` with a `requestId` and SHALL
block until a decision is delivered.

#### Scenario: Approve
- **WHEN** a decision `allow` is posted for `requestId`
- **THEN** the adapter forwards it to the harness
- **AND** execution continues

#### Scenario: Deny
- **WHEN** a decision `deny` is posted
- **THEN** the harness receives the denial
- **AND** the tool call completes with `ok: false`

### Requirement: Opencode adapter

The opencode adapter SHALL connect to an `opencode serve` instance over HTTP+SSE, map sessions/prompts/
tool calls/diffs/usage to canonical events, and support cancel and permission responses.

#### Scenario: Start and prompt
- **WHEN** a session is started against a reachable opencode server and a prompt is sent
- **THEN** `run.started` is emitted followed by streamed message and tool-call events
- **AND** a patch is retrievable via `getDiff`

#### Scenario: Server unreachable
- **WHEN** the opencode server does not respond within the readiness timeout
- **THEN** the adapter fails with code `harness_unreachable`
- **AND** the run ends with `status: error`
