# Design

## Decisions

1. **Names only.** The registry stores `{name, provider, scope, description, lastRotatedAt, createdAt}`. A
   `value` field is rejected with `secret_value_rejected`; the API never returns a value, not even masked.
2. **Existence check, not custody.** "Create" registers a name and verifies it resolves in the runtime
   environment (`env` provider) without reading the value into the response. A missing value registers as
   `unresolved` and is surfaced, not blocked (dev convenience).
3. **Usage audit.** The lease/run path records resolved names (`run_secrets`), never values. The Secrets page
   shows last-used run + count.
4. **Definition validation.** An agent or MCP server referencing an unregistered name produces a warning
   (`secret_unregistered`), not an error, so a fresh checkout validates.
5. **MCP in the definition.** `mcp` block on the factory (servers) and `agents[].mcp` (allow list). Transport
   `stdio` (command + args + env secret refs) or `http` (url + header secret refs). Inline secret-looking args
   (`sk-…`, `ghp_…`) are rejected with `secret_inline_rejected`.
6. **Per-agent permissions.** opencode merges agent permissions over global; we emit
   `{"<server>*": "allow"}` for servers in the agent's allow list and `"deny"` for the rest, per
   <https://opencode.ai/docs/tools/>.
7. **Connection test.** `POST /factories/:name/mcp/:server/test` performs a transport-level probe (spawn +
   handshake for stdio, HEAD/initialize for http) inside the runner, not the API process (ADR-010).
8. **MCPs & apps page** lists servers with status, agents bound, tools allowed/denied, and last test result.

## Risks

- A registry that cannot read values cannot verify correctness — it verifies *presence*, and the first real run
  is the real test. Say so in the UI.
- MCP tool permission globs are opencode-specific; the adapter maps them to the canonical capability flags for
  other harnesses (best effort, recorded).
