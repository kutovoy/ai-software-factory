# Tasks

## 1. Schema (`packages/core`)

- [ ] 1.1 `mcp` block on the factory (servers: name, transport, command/args/env refs, url/headers refs) and
      `agents[].mcp` allow list
- [ ] 1.2 Validation: `invalid_value` (transport), `secret_inline_rejected`, `unknown_mcp_server`
- [ ] 1.3 Warning `secret_unregistered` when a referenced name is not in the registry (non-fatal)
- [ ] 1.4 Update `factories/example` with one stdio MCP server + one agent binding; canonical snapshot

## 2. Persistence (`packages/core`)

- [ ] 2.1 `012_secrets_mcp.sql`: `secrets`, `secret_usage`, `mcp_servers`, `mcp_bindings`, `mcp_tests`
      (011 is taken by `harden-runtime`)
- [ ] 2.2 Repository: register (reject `value`), presence check via env provider, delete guard
      (`secret_in_use`), usage upsert, server/binding upsert, test result

## 3. API (`apps/api`)

- [ ] 3.1 `GET/POST/DELETE /secrets`, `POST /secrets/:name/rotate` (re-register, no value)
- [ ] 3.2 `GET /secrets/:name/usage`
- [ ] 3.3 `GET/POST /factories/:name/mcp`, `POST /factories/:name/mcp/:server/test` (probe via runner)
- [ ] 3.4 Lease/run path records resolved secret names (`run_secrets`), never values
- [ ] 3.5 Tests: value rejected, delete-in-use refused, unresolved status, usage audit, unknown server,
      inline secret rejected, test success/failure

## 4. Adapter wiring (`packages/adapters`)

- [ ] 4.1 Pass MCP servers + per-agent permission globs (`"<server>*": allow|deny`) into the opencode session
- [ ] 4.2 Map to canonical capability flags for harnesses without MCP support (recorded, best effort)
- [ ] 4.3 Contract test with recorded fixtures: config shape, no secret values in the payload

## 5. UI (`apps/web`)

- [ ] 5.1 Secrets page: list (name, provider, scope, status, last rotation, last used), create dialog,
      delete with in-use explanation, rotate-by-reference
- [ ] 5.2 MCPs & apps page: servers (transport, status, agents bound, tool allow/deny), add server, test button
- [ ] 5.3 Agent page shows bound MCP servers + denied tools
- [ ] 5.4 Empty states that say what is missing, not placeholders

## 6. Tests & wrap-up

- [ ] 6.1 Integration: register secret → lease resolves name → usage recorded; MCP test probe (fake transport)
- [ ] 6.2 E2E: secrets page create/delete, MCP page server + test, agent binding visible
- [ ] 6.3 Smoke: register secret, run resolves it, usage row appears; MCP server validates and rejects inline secret
- [ ] 6.4 STATUS + ADR-026 (names not values) + ADR-027 (MCP permissions are per-agent globs)
- [ ] 6.5 `openspec validate add-secrets-and-mcp`
