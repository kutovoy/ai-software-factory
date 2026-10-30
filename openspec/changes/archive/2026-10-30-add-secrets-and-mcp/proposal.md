# Proposal

## Why

Two nav items are still Phase-6 stubs: **Secrets** and **MCPs and apps**. Secrets already exist as *names*
resolved at run time, but there is no registry UI, no validation that a referenced secret exists, and no audit
of who used it. MCP servers are configured for opencode globally today; the factory needs per-agent wiring with
explicit tool permissions.

## What Changes

- **Secrets registry:** `GET/POST/DELETE /secrets` storing names + metadata only (provider, scope, last
  rotation, used-by) — values stay in the environment/secret manager and are never returned. A definition
  validator warns when an agent references a secret that is not registered.
- **Usage audit:** every lease/run records which secret names were resolved, so the Secrets page can show
  usage and the last run that used each one.
- **MCP registry + per-agent wiring:** `GET/POST /factories/:name/mcp` with servers (name, transport,
  command/url, env secret refs) and per-agent `mcp` allow lists; validation rejects unknown server names and
  secret-valued inline args.
- **opencode wiring:** the adapter passes MCP servers and per-agent permission globs (`"<server>*": allow`)
  into the session config, per <https://opencode.ai/docs/config/> and the documented per-agent permission merge.
- **UI:** real Secrets page (list, create, rotate-by-reference, usage) and MCPs & apps page (servers, agents,
  tool allow/deny, connection test).

## Capabilities

### New Capabilities
- `secrets`: a name-only registry with usage audit and definition validation.
- `mcp-integration`: per-agent MCP server wiring with explicit tool permissions.

## Impact

- New tables, routes, pages; definition schema gains `mcp` on agents and `secrets` metadata.
- No secret values in the database, logs, events or definitions.
