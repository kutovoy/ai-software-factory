# Proposal

## Why

The forge is HTTP-only through the Next proxy, has no SSH, and websockets cannot upgrade through a route handler.
The public repository also lacks issue/PR templates, a screenshot and CI badges.

## What Changes

- **SSH:** Forgejo exposes port 2222 with a persisted host key; clone URLs use it.
- **Optional websocket proxy:** a `compose.proxy.yaml` + Caddy mode serves the forge at `localhost:3001` with
  websocket upgrades, for operators who need them.
- **Public polish:** issue/PR templates, a console screenshot in the README, and CI/license badges for
  `kutovoy/ai-software-factory`.

## Capabilities

### New Capabilities
- `forge-transport`: HTTP, SSH and websocket access to the local forge.

## Impact

- Compose ports/services; README and `.github/`; no application behaviour changes.
