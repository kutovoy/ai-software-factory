---
description: Writes the acceptance criteria and file plan for the React + Three.js train game.
harness:
  model: env:FACTORY_MODEL
  type: opencode
role: spec
runner: local-docker
spawnableBy:
  - foreman
---

# Spec

Write the smallest specification that makes the train game testable. Do not write the
implementation.

## Scope

- A new `train-game/` directory at the repository root.
- Vite + React + TypeScript + Three.js. Use Three.js directly from a React component; no
  React Three Fiber dependency.
- A single-page 3D game that runs entirely in the browser with no network calls, no external
  assets and no backend.

## Required files

- `train-game/package.json` with `react`, `react-dom`, `three`, `vite`, `@vitejs/plugin-react`
  and `typescript`; scripts `dev`, `build` and `preview`.
- `train-game/index.html`
- `train-game/tsconfig.json` and `train-game/tsconfig.node.json`
- `train-game/vite.config.ts`
- `train-game/src/main.tsx`, `train-game/src/App.tsx`, `train-game/src/styles.css`
- `train-game/src/game/TrainGame.tsx` (React wrapper and Three.js scene)
- `train-game/src/game/state.ts` (game state, test hook and constants)
- `train-game/README.md` with run/build instructions and controls.

## Gameplay acceptance criteria

1. A 3D scene renders in a `<canvas>` with a ground plane, a track connecting two stations,
   a train (locomotive plus at least one wagon), station markers and cargo crates.
2. The camera follows the train from a useful third-person angle; the scene has lighting and
   a readable sky/background.
3. The train starts at Station A with cargo loaded. The HUD shows speed, cargo status,
   current/next station, deliveries and controls.
4. `W` / `ArrowUp` increases throttle; `S` / `ArrowDown` brakes and can reverse slowly. The
   train cannot leave the track corridor.
5. When the train is stopped at a station, `Space` loads or unloads cargo. Delivering cargo
   at the destination increments `deliveries`; the next cargo is loaded for the return trip.
6. After three successful deliveries the HUD shows a win state; `R` resets the game.
7. Expose a deterministic browser test hook:
   `window.__TRAIN_GAME__ = { getState(), teleportToStation(id), reset() }`.
   `getState()` returns `{ speed, position, cargo, atStation, deliveries, status }`.
   `teleportToStation('station-a' | 'station-b')` places the stopped train at that station.
8. No uncaught console errors during load or normal play.

## Verification plan

The QA agent will build the app, serve it on port 3100, and run Playwright against it:
canvas presence, HUD, speed after `ArrowUp`, delivery through the deterministic test hook,
and a clean console. Review will check scope, code quality and that the test hook is not a
substitute for the real game loop.
