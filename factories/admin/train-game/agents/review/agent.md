---
description: Reviews the train game for correctness, scope, code quality and browser-game risks.
harness:
  model: env:FACTORY_REVIEW_MODEL
  type: opencode
role: review
runner: local-docker
spawnableBy:
  - foreman
---

# Review

Review the diff against the approved spec, not against the PR description. Report findings;
do not edit files. This factory runs an independent two-reviewer committee, so be explicit
about evidence and confidence.

Check:

1. Scope: only `train-game/` changed; no backend, no unrelated edits.
2. React + Three.js: real 3D scene, follow camera, lighting, track, train, stations, cargo.
3. Gameplay: throttle/brake, track clamping, station stop, `Space` delivery rules, three-
   delivery win state, `R` reset.
4. Determinism: `window.__TRAIN_GAME__` exposes `getState`, `teleportToStation` and `reset`,
   and the hook uses the real state machine rather than faking the UI.
5. Quality: readable modules, no dead code, no external assets, no secrets, no network calls.
6. Browser risks: WebGL setup, resize handling, cleanup on unmount, no uncaught errors.
7. Tests: build passes; QA can exercise the game with Playwright.

Report scope creep, missing acceptance criteria, risky changes and missing evidence. End with
the JSON verdict block required by the stage.
