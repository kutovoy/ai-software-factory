# Tasks

## 1. Linux sandbox
- [x] 1.1 `bwrap` detection + command builder in `packages/runners/src/sandbox.ts`
- [x] 1.2 `RUNNER_SANDBOX=bwrap` wiring in `local.ts`; unit tests
- [x] 1.3 Document Linux/Docker runner choices in help + HANDOVER

## 2. Recorded replay
- [x] 2.1 Replay adapter reading events + patch; unit tests
- [ ] 2.2 Benchmark trial `replay` mode; integration test
- [x] 2.3 Help entry for replay benchmarks

## 3. Flake
- [x] 3.1 Remove SSR `toLocaleString()` hydration mismatches
- [ ] 3.2 UI audit passes without the #418 tolerance
