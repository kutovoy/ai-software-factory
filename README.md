# Software Factory

An open, model-agnostic, harness-agnostic software factory: a team of AI agents running the
SDLC loop behind a web UI, with definitions stored as versioned code.

Phase 1 (this change) ships the factory definition format: schema, loader, canonical export,
semantic diff, gates resolver and version pinning.

## Quickstart

```bash
bun install

bun run typecheck
bun test

bun run factory validate factories/example
bun run factory export factories/example --out /tmp/example
bun run factory diff factories/example factories/example-lights-off
bun run factory version factories/example --allow-dirty
```

`bun run ci` runs typecheck, tests and both reference-factory validations.

## Layout

```
packages/core   Zod schemas, loader, canonical serializer, hash, gates, diff, version pinning
packages/cli    the `factory` binary (validate | export | import | diff | fmt | version)
factories/      factory definitions as code (factory.yaml + agents/ + automations/ + ...)
openspec/       specs and in-flight change proposals
```
