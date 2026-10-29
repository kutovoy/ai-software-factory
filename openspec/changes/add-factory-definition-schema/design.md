# Design

## Context

The reference product (Warp Factories) defines a factory as `factory.yaml` plus a directory tree where a
resource's name *is* its path (`agents/<name>/agent.md`). That shape has proven properties we want:
no name/index drift, Markdown frontmatter for config + prose body for instructions, and files that agents
can safely rewrite as diffs. Gas City contributes the "pack + lockfile" composition idea; Harness²
contributes the idea that every tunable is a file so improvements are reviewable.

Constraints: TypeScript + Bun, Postgres index only, definitions must round-trip byte-identically after
canonical formatting, and the schema must express gates/merge policy (which Warp lacks).

## Goals / Non-Goals

**Goals:**
- One Zod schema module that is the single source of truth for the definition format.
- `validate` with actionable, path-qualified errors (file + JSON pointer).
- Lossless round-trip: `export` → `import` → `export` produces identical bytes.
- Semantic `diff` between two definition trees (added/removed/changed resources, field-level).
- Gate/merge-policy resolution as a pure function with a documented precedence.
- Version pinning: a definition version = git commit SHA + optional `factory-vN` tag.
- Reference factory that validates and exercises every resource type.

**Non-Goals:**
- No UI in this change.
- No Temporal, adapters, or runners.
- No GitHub integration.
- No DB queries beyond defining the index schema/migration file.
- No pack resolution/imports beyond a `packs.lock` placeholder field (Phase 5+).

## Decisions

1. **Schema versioning.** `schemaVersion: v1alpha1` in `factory.yaml`. The loader rejects unknown
   `schemaVersion` with a migration hint. Breaking changes bump to `v1alpha2` with a codemod.
2. **Path is identity.** Resource name is derived from its path, never duplicated inside frontmatter.
   Renaming = moving the file. Duplicate/ambiguous paths are validation errors.
3. **`model` xor `harness`.** Exactly one of `model` (OpenAI-compatible model id) or `harness`
   (`{type, model, reasoningLevel?, auth?}`) may appear at any level that selects inference; `agentDefaults`
   must declare exactly one. This keeps provider-agnosticism explicit.
4. **Gates as a resolved policy, not scattered booleans.** `factory.gates` maps stage → `human | agent |
   policy:<name>`; automations may override per stage. Resolution order: automation → factory → global
   default. A separate `mergePolicy` enum governs merge. Resolution is a pure, unit-tested function.
5. **Canonical formatting.** `export` emits deterministic YAML (sorted keys, 2-space indent, trailing
   newline) and Markdown with stable frontmatter key order. Round-trip equality is enforced by tests.
6. **Diff is semantic.** Compare parsed documents, not text: report `added`, `removed`, `changed` with
   field paths, plus a rendered unified diff for humans.
7. **DB index is derived.** Tables `factory_definitions`, `factory_versions`, `resources` store
   `(factory, commit, path, kind, name, hash, doc)`; never written by the UI as truth.
8. **CLI over library-only.** `packages/cli` exposes `factory validate|export|import|diff|fmt|version` so
   agents and CI can use it without importing internals.

## Risks / Trade-offs

- **YAML canonicalisation is fiddly.** Mitigation: normalise via parse → Zod → plain object → stable
  stringify; snapshot tests on the reference factory.
- **Schema churn early.** Mitigation: `v1alpha1` + explicit migration notes; keep fields optional until
  Phase 3 needs them.
- **Markdown frontmatter parsing edge cases** (nested YAML, `---` in body). Mitigation: require frontmatter
  at byte 0, parse with a strict splitter, and reject bodies starting with `---`.
- **Gates resolution ambiguity** (automation override vs factory default vs "policy"). Mitigation: single
  resolver module, table-driven tests covering every precedence pair.
