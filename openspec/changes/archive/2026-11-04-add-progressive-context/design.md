# Design

## Context

`resolveMcpWiring` returns every server the agent binds. The harness therefore pays for all
MCP schemas on every run. `mcp_servers`/`mcp_bindings` are a derived index; there is no tool
metadata table.

## Decisions

### 1. Deterministic capability selector

`scoreCapability` counts prompt tokens found in `server`, `tool` and `description`; promoted
entries get +2. `selectCapabilities` sorts by score, applies `maxServers`, and reports
full/selected schema bytes plus a savings ratio. No model, no network.

### 2. Progressive server selection

When `mcp.discovery.enabled` is true and the run has a prompt, `resolveMcpWiring` selects the
top capabilities and hands only those servers to the harness. Permission globs for
non-selected servers become `deny`, so the config states the denial explicitly. If nothing
matches, one declared/promoted server is kept so the run is not starved.

### 3. Discovery and promotion are explicit

`POST /capabilities/discover` validates that the server is declared, then upserts tool
metadata (`name`, `description`, schema, schema bytes). `POST /capabilities/:server/:tool/
promote` marks a tool promoted; promoted tools rank higher in selection. The definition stays
the source of truth for server declarations.

### 4. Token-savings accounting

`GET /capabilities/stats?q=` returns `fullSchemaBytes`, `selectedSchemaBytes`, `savingsRatio`
and the selected entries. This is a deterministic size proxy, not a tokenizer count.

## Risks / Trade-offs

- Keyword selection can miss a relevant capability; the one-capability fallback and explicit
  promotion mitigate it.
- Tool schemas are stored as JSONB; no credentials are stored.
- A server with no discovered tools still participates via its name/description.

## Migration

`021_mcp_tools.sql` creates the tool index. No data rewrite.
