# Design

## Decisions

1. **SSH is additive.** Base compose publishes `2222:22`; Forgejo advertises `SSH_PORT=2222` and keeps HTTP
   through the console proxy. Host keys live in the existing data volume.
2. **Websockets are an optional mode.** `compose.proxy.yaml` runs Caddy on `:3001`, sets the forge root URL to
   that origin and proxies all paths (including upgrades). The default single-origin setup stays unchanged.
3. **Public surface.** GitHub issue forms (bug/feature), a PR template, a real screenshot under `docs/assets/`,
   and badges that point at the actual repository.
