# Tasks

## 1. Workspace scaffold

- [x] 1.1 Root `package.json` with Bun workspaces (`apps/*`, `packages/*`), scripts: `typecheck`, `test`, `lint`, `factory`
- [x] 1.2 `tsconfig.base.json` (strict, ESM, bundler resolution) + per-package `tsconfig.json`
- [x] 1.3 `.gitignore` already covers `node_modules/`, `dist/`; add `factories/*/.factory-cache/`
- [x] 1.4 `packages/core`, `packages/cli` package skeletons with `src/index.ts`
- [x] 1.5 Root `README.md` quickstart (install, validate example factory)

## 2. Schema (`packages/core/src/schema`)

- [x] 2.1 `factory.ts` — root manifest Zod schema (`schemaVersion`, `name`, `alias`, `description`, `repositories`, `agentDefaults`, `gates`, `mergePolicy`, `secrets`, `mcpServers`, `integrations`, `selfImprovement`)
- [x] 2.2 `agent.ts` — frontmatter schema (`role`, `model` xor `harness`, `runner`, `tools`, `secrets`, `mcpServers`, `spawnableBy`, `idleTimeoutMinutes`)
- [x] 2.3 `automation.ts` — triggers (`provider`, `event`, `filter`, `schedule`), `enabled`, `agent`, execution overrides, per-stage `gates`
- [x] 2.4 `scorer.ts` — `labels[{value, description?, score}]`, `passingScore`, `samplingRate`, `judgeModel`, `selfImprovement`
- [x] 2.5 `benchmark.ts` — `suite.yaml` + `tasks/*.yaml` (`startingRepoRefs` full 40-char SHA validation)
- [x] 2.6 `skill.ts`, `runner.ts`, `routing.ts`
- [x] 2.7 Shared refinements: `model` xor `harness`, secret reference resolution, unique names, cron validation
- [x] 2.8 Export inferred TS types (`FactoryDefinition`, `AgentDef`, …) from schemas

## 3. Loader & canonical form (`packages/core/src/loader`)

- [x] 3.1 Directory walker that classifies files by path into resource kinds; rejects unknown paths
- [x] 3.2 Markdown frontmatter splitter (strict: frontmatter at byte 0, `---` delimited, body preserved verbatim)
- [x] 3.3 Parse → validate → normalise into an in-memory `FactoryDefinition` tree
- [x] 3.4 Stable serializer: sorted YAML keys, 2-space indent, trailing newline, stable frontmatter key order
- [x] 3.5 Content hash of a definition tree (order-independent, sha256)
- [x] 3.6 Structured `ValidationError` (`code`, `file`, `pointer`, `message`) and error aggregation

## 4. Gates resolver (`packages/core/src/gates`)

- [x] 4.1 `resolveGate(stage, automation?, factory, globalDefault)` pure function
- [x] 4.2 `resolveAllGates(factory)` returning per-stage decisions + `fullyAutonomous` flag
- [x] 4.3 Autonomy guard: `fullyAutonomous` requires `mergePolicy: auto_on_green|auto_after_n_approvals` and reports `benchmarkGateRequired: true`
- [x] 4.4 Table-driven tests for every precedence pair and invalid values

## 5. Diff (`packages/core/src/diff`)

- [x] 5.1 Semantic diff over two `FactoryDefinition` trees → `{added[], removed[], changed[]}`
- [x] 5.2 Field-level paths (JSON pointer) with old/new values
- [x] 5.3 Human renderer (unified-diff-like) + JSON renderer
- [x] 5.4 `--exit-code` semantics for CI

## 6. Version pinning (`packages/core/src/version`)

- [x] 6.1 `createVersion(dir)` → `{commit, tag?, contentHash, dirty}` using git plumbing (`rev-parse`, `status --porcelain`)
- [x] 6.2 `--allow-dirty` support with explicit `dirty: true`
- [x] 6.3 Refuse to create a version when `factory.yaml` fails validation

## 7. CLI (`packages/cli`)

- [x] 7.1 `factory validate <dir> [--json]` → exit 0/1, human or JSON errors
- [x] 7.2 `factory export <dir> --out <dir> [--check]` → canonical write; `--check` fails if not canonical
- [x] 7.3 `factory import <dir>` → parse + validate (no DB writes yet)
- [x] 7.4 `factory diff <a> <b> [--json] [--exit-code]`
- [x] 7.5 `factory fmt <dir>` → rewrite in canonical form
- [x] 7.6 `factory version <dir> [--allow-dirty]` → print JSON version record

## 8. DB index (`packages/core/migrations`)

- [x] 8.1 `001_factory_index.sql` — `factory_definitions`, `factory_versions`, `resources` (with `commit`, `path`, `kind`, `name`, `hash`, `doc jsonb`)
- [x] 8.2 Index on `(factory, commit)` and `(factory, kind, name)`
- [x] 8.3 Document in `packages/core/README.md` that these tables are derived, never authoritative

## 9. Reference factory (`factories/example`)

- [x] 9.1 `factory.yaml` with gates (`spec/plan/pr_review: human`, rest `agent`), `mergePolicy: human`
- [x] 9.2 Agents: `foreman`, `triage`, `spec`, `implement`, `review`, `verify` (model xor harness; opencode harness)
- [x] 9.3 One automation (GitHub `issue_labeled`), one scorer (`scope`), one benchmark suite + 2 tasks, one skill, one runner
- [x] 9.4 `routing.yaml` mapping stages to model/harness
- [x] 9.5 A second variant `factories/example-lights-off` differing only in gates/mergePolicy (for diff demo)

## 10. Tests & CI

- [x] 10.1 Unit tests: schema refinements, gates resolver, diff engine, hash stability
- [x] 10.2 Round-trip test: `export → import → export` byte-identical on both example factories
- [x] 10.3 Negative tests: each validation error code has at least one fixture
- [x] 10.4 `bun test` + `bun run typecheck` wired into a `scripts/ci.sh`
- [x] 10.5 Snapshot test of canonical output for `factories/example`

## 11. Wrap-up

- [x] 11.1 Update `docs/STATUS.md` (Phase 1 complete, Phase 2 next)
- [x] 11.2 Add ADR-007 (definition schema v1alpha1) and ADR-008 (semantic diff + canonical form)
- [x] 11.3 `openspec validate add-factory-definition-schema` passes
- [x] 11.4 Commit + tag `factory-v0` (bootstrap definition)
