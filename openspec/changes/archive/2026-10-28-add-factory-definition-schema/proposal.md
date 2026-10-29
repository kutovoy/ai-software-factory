# Proposal

## Why

Nothing in the factory is testable until the factory itself is a well-defined, versioned artifact. Today
the design exists only as prose in `docs/ARCHITECTURE.md` and research notes. We need an executable schema,
a loader/validator, and a git round-trip so that:

- runs can pin an exact factory version (`definitionCommit`) and be compared later;
- agents (and humans) can propose improvements as diffs against files rather than mutating a database;
- the UI can show a diff/history/clone view instead of being the source of truth;
- benchmarks can compare factory versions, not just models.

This is Phase 1 of `docs/ROADMAP.md` and the prerequisite for every later phase.

## What Changes

- Introduce a Bun-workspace monorepo scaffold (`apps/`, `packages/`, `factories/`).
- Add `packages/core`: Zod schemas for the factory definition format, a loader, a validator, a
  normalizer/serializer, and a diff engine.
- Add a `factory` CLI with `validate`, `export`, `import`, `diff`, `fmt`, `version` commands.
- Add a reference factory at `factories/example/` exercising every resource type.
- Add git round-trip guarantees: `export` writes canonical files; `import` reads them back; `diff`
  reports semantic (not textual) differences.
- Add a DB index schema (Postgres) that mirrors definitions for querying — definitions remain the truth.
- Define gates + merge policy in `factory.yaml` (lights-on/off dial), which later phases consume.

## Capabilities

### New Capabilities
- `factory-definition`: the declarative, git-versioned description of a factory — its schema, resource
  layout, validation rules, gate/merge policy resolution, version pinning, and lossless round-trip.

### Modified Capabilities
<!-- none yet; openspec/specs/ is empty -->

## Impact

- New code: `packages/core`, `packages/cli`, root workspace config, `factories/example`.
- New dependency: `zod` (validation), `yaml` (parsing/serialisation), `vitest` or `bun:test`.
- No runtime services required yet; no DB migrations applied in this change beyond the index schema file.
- Downstream: Phase 2 (Temporal + adapters) and Phase 3 (gates) consume this schema directly.
