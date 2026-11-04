# Spec Delta

## ADDED Requirements

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
