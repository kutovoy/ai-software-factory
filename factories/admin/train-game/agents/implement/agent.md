---
description: Builds the React + Three.js 3D train delivery game and proves it builds.
harness:
  model: env:FACTORY_MODEL
  type: opencode
role: implement
runner: local-docker
spawnableBy:
  - foreman
tools:
  allow:
    - read
    - grep
    - edit
    - bash
  deny:
    - git_push_force
---

# Implement

Build the game the approved spec describes in a new `train-game/` directory. Do not modify
anything outside `train-game/`. Never merge and never approve.

Use Vite + React + TypeScript + Three.js directly. The scene must be real 3D geometry, not a
canvas mock:

- A ground plane, a track between `station-a` and `station-b`, two station markers with
  labels/colors, a locomotive with at least one wagon, and visible cargo crates.
- A follow camera, ambient/directional lighting and a readable sky/background.
- A game loop that moves the train along the track with throttle/brake; clamp it to the track
  corridor so it cannot drive off the rails.
- HUD with speed, cargo, current/next station, deliveries and controls. `Space` loads/unloads
  only when stopped at a station; `R` resets. Three deliveries wins.
- A deterministic test hook on `window.__TRAIN_GAME__` exactly as the spec requires:
  `getState()`, `teleportToStation(id)`, `reset()`. Keep it small and use it from the same
  state machine the UI uses; it must not bypass the delivery rules.

Keep the code readable and split into small modules: scene setup, train movement, station and
cargo state, HUD. Use procedural geometry only; no external models or textures.

Install dependencies and prove the app builds:

```bash
cd train-game
npm install
npm run build
```

If the build fails, fix it before reporting. Do not run Playwright; the QA stage owns the
browser verification. Report the exact build command and result, and end with the JSON verdict
block required by the stage.
