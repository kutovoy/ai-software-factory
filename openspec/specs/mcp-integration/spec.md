# mcp-integration Specification

## Purpose
Defines per-agent MCP server wiring: servers declared in the definition, bound to agents with explicit tool
permissions, and tested inside the runner.

## Requirements

### Requirement: MCP server declaration

A factory SHALL declare MCP servers with a transport and credential references.

#### Scenario: Stdio server
- **WHEN** a server declares `transport: stdio` with a command and args
- **THEN** it validates if the command is present
- **AND** environment entries referencing secrets use names, not values

#### Scenario: Inline secret
- **WHEN** a command, arg or URL contains a credential-looking literal
- **THEN** validation fails with `secret_inline_rejected`

#### Scenario: Unknown transport
- **WHEN** the transport is not `stdio` or `http`
- **THEN** validation fails with `invalid_value`

### Requirement: Per-agent binding

Agents SHALL declare which MCP servers they may use, and unknown names SHALL be rejected.

#### Scenario: Bound
- **WHEN** an agent lists a server in its `mcp` allow list
- **THEN** the harness receives that server with tool permissions allowing `"<server>*"`
- **AND** servers not listed are denied

#### Scenario: Unknown server
- **WHEN** an agent references a server that is not declared
- **THEN** validation fails with `unknown_mcp_server` naming the agent and server

#### Scenario: No binding
- **WHEN** an agent declares no `mcp`
- **THEN** it receives no MCP servers
- **AND** the resolved config says so explicitly

### Requirement: Connection test

A server SHALL be testable without exposing credentials to the API process.

#### Scenario: Test
- **WHEN** `POST /factories/:name/mcp/:server/test` runs
- **THEN** the probe executes inside the runner
- **AND** the result records transport, latency and error (if any)

#### Scenario: Failure
- **WHEN** the probe fails
- **THEN** the server is marked `unhealthy` with the error
- **AND** agents bound to it still validate (the failure is runtime, not definition)

### Requirement: Progressive MCP context

Factories MAY enable `mcp.discovery`; when enabled, the harness SHALL receive only the MCP
servers relevant to the task prompt.

#### Scenario: Selection
- **WHEN** discovery is enabled and the run has a prompt
- **THEN** servers are ranked by deterministic keyword match
- **AND** at most `maxServers` are handed to the harness
- **AND** non-selected declared servers receive an explicit deny glob

#### Scenario: No match
- **WHEN** no server matches the prompt
- **THEN** one declared/promoted server is kept
- **AND** the reason says no keyword match

#### Scenario: Savings
- **WHEN** a prompt is supplied to the capability stats endpoint
- **THEN** it reports full schema bytes, selected schema bytes and a savings ratio

### Requirement: Capability discovery

The API SHALL persist discovered MCP tool metadata and allow explicit promotion.

#### Scenario: Discover
- **WHEN** a declared server's tools are posted to the discover endpoint
- **THEN** each tool is upserted with its description and schema size

#### Scenario: Promote
- **WHEN** a discovered tool is promoted
- **THEN** it is marked `promoted`
- **AND** it ranks higher in later selections

#### Scenario: Unknown server
- **WHEN** discovery targets a server not declared in the definition
- **THEN** the request is refused with `invalid_request`
