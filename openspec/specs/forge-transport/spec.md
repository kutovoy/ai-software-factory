# forge-transport Specification

## Purpose
The local forge is reachable over HTTP, SSH and websockets.

## Requirements

### Requirement: SSH access

The forge SHALL accept git-over-SSH on a published port.

#### Scenario: Clone
- **WHEN** a user clones `ssh://git@localhost:2222/<org>/<repo>.git`
- **THEN** the forge serves the repository

### Requirement: Optional websocket proxy

Operators SHALL be able to serve the forge through a websocket-capable proxy.

#### Scenario: Proxy mode
- **WHEN** compose is started with `compose.proxy.yaml`
- **THEN** the forge is served at `http://localhost:3001` with upgrade support
