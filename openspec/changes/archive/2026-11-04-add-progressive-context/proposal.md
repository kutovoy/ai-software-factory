# Proposal

## Why

Every bound MCP server is handed to the harness on every run, and there is no index of the
tools a server exposes. Roadmap item 9 asks for progressive context: a capability index,
discover → promote → reuse, and deferred schemas until a task needs them.

## What Changes

- Add optional `mcp.discovery` (`enabled`, `maxServers`) to `factory.yaml`.
- Add a deterministic capability index and keyword selector in `packages/core`.
- Filter bound MCP servers to the selected capabilities when discovery is enabled and a task
  prompt exists; keep one capability when nothing matches.
- Persist discovered tool metadata in `mcp_tools` (migration 021).
- Add nested API routes: list capabilities, discover tools, promote a tool, and report
  full-vs-selected schema bytes.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `mcp-integration`: capability index, discovery/promotion and progressive server selection.

## Impact

- `packages/core/src/{schema/mcp,mcp/capabilities,mcp/wiring,mcp/repository}.ts`
- `packages/orchestration/src/sessions.ts`
- `apps/api/src/capabilities.ts`, `apps/api/src/app.ts`, `apps/api/openapi.json`
- `packages/core/migrations/021_mcp_tools.sql`
- `factories/hello-nextjs/factory.yaml` opts in with no declared servers (no behaviour change).

## Non-goals

- No MCP protocol client that enumerates tools automatically; discovery accepts metadata.
- No automatic promotion; promotion is explicit.
- No secret values in the index; only names and schemas.
