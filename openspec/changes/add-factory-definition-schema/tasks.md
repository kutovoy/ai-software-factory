# Tasks

## 1. Workspace scaffold

- [ ] 1.1 Root `package.json` with Bun workspaces (`apps/*`, `packages/*`), scripts: `typecheck`, `test`, `lint`, `factory`
- [ ] 1.2 `tsconfig.base.json` (strict, ESM, bundler resolution) + per-package `tsconfig.json`
- [ ] 1.3 `.gitignore` already covers `node_modules/`, `dist/`; add `factories/*/.factory-cache/`
- [ ] 1.4 `packages/core`, `packages/cli` package skeletons with `src/index.ts`
- [ ] 1.5 Root `README.md` quickstart (install, validate example factory)

## 2. Schema (`packages/core/src/schema`)

- [ ] 2.1 `factory.ts` — root manifest Zod schema (`schemaVersion`, `name`, `alias`, `description`, `repositories`, `agentDefaults`, `gates`, `mergePolicy`, `secrets`, `mcpServers`, `integrations`, `selfImprovement`)
- [ ] 2.2 `agent.ts` — frontmatter schema (`role`, `model` xor `harness`, `runner`, `tools`, `secrets`, `mcpServers`, `spawnableBy`, `idleTimeoutMinutes`)
- [ ] 2.3 `automation.ts` — triggers (`provider`, `event`, `filter`, `schedule`), `enabled`, `agent`, execution overrides, per-stage `gates`
- [ ] 2.4 `scorer.ts` — `labels[{value, description?, score}]`, `passingScore`, `samplingRate`, `judgeModel`, `selfImprovement`
- [ ] 2.5 `benchmark.ts` — `suite.yaml` + `tasks/*.yaml` (`startingRepoRefs` full 40-char SHA validation)
- [ ] 2.6 `skill.ts`, `runner.ts`, `routing.ts`
- [ ] 2.7 Shared refinements: `model` xor `harness`, secret reference resolution, unique names, cron validation
- [ ] 2.8 Export inferred TS types (`FactoryDefinition`, `AgentDef`, …) from schemas

## 3. Loader & canonical form (`packages/core/src/loader`)

- [ ] 3.1 Directory walker that classifies files by path into resource kinds; rejects unknown paths
- [ ] 3.2 Markdown frontmatter splitter (strict: frontmatter at byte 0, `---` delimited, body preserved verbatim)
- [ ] 3.3 Parse → validate → normalise into an in-memory `FactoryDefinition` tree
- [ ] 3.4 Stable serializer: sorted YAML keys, 2-space indent, trailing newline, stable frontmatter key order
- [ ] 3.5 Content hash of a definition tree (order-independent, sha256)
- [ ] 3.6 Structured `ValidationError` (`code`, `file`, `pointer`, `message`) and error aggregation

## 4. Gates resolver (`packages/core/src/gates`)

- [ ] 4.1 `resolveGate(stage, automation?, factory, globalDefault)` pure function
- [ ] 4.2 `resolveAllGates(factory)` returning per-stage decisions + `fullyAutonomous` flag
- [ ] 4.3 Autonomy guard: `fullyAutonomous` requires `mergePolicy: auto_on_green|auto_after_n_approvals` and reports `benchmarkGateRequired: true`
- [ ] 4.4 Table-driven tests for every precedence pair and invalid values

## 5. Diff (`packages/core/src/diff`)

- [ ] 5.1 Semantic diff over two `FactoryDefinition` trees → `{added[], removed[], changed[]}`
- [ ] 5.2 Field-level paths (JSON pointer) with old/new values
- [ ] 5.3 Human renderer (unified-diff-like) + JSON renderer
- [ ] 5.4 `--exit-code` semantics for CI

## 6. Version pinning (`packages/core/src/version`)

- [ ] 6.1 `createVersion(dir)` → `{commit, tag?, contentHash, dirty}` using git plumbing (`rev-parse`, `status --porcelain`)
- [ ] 6.2 `--allow-dirty` support with explicit `dirty: true`
- [ ] 6.3 Refuse to create a version when `factory.yaml` fails validation

## 7. CLI (`packages/cli`)

- [ ] 7.1 `factory validate <dir> [--json]` → exit 0/1, human or JSON errors
- [ ] 7.2 `factory export <dir> --out <dir> [--check]` → canonical write; `--check` fails if not canonical
- [ ] 7.3 `factory import <dir>` → parse + validate (no DB writes yet)
- [ ] 7.4 `factory diff <a> <b> [--json] [--exit-code]`
- [ ] 7.5 `factory fmt <dir>` → rewrite in canonical form
- [ ] 7.6 `factory version <dir> [--allow-dirty]` → print JSON version record

## 8. DB index (`packages/core/migrations`)

- [ ] 8.1 `001_factory_index.sql` — `factory_definitions`, `factory_versions`, `resources` (with `commit`, `path`, `kind`, `name`, `hash`, `doc jsonb`)
- [ ] 8.2 Index on `(factory, commit)` and `(factory, kind, name)`
- [ ] 8.3 Document in `packages/core/README.md` that these tables are derived, never authoritative

## 9. Reference factory (`factories/example`)

- [ ] 9.1 `factory.yaml` with gates (`spec/plan/pr_review: human`, rest `agent`), `mergePolicy: human`
- [ ] 9.2 Agents: `foreman`, `triage`, `spec`, `implement`, `review`, `verify` (model xor harness; opencode harness)
- [ ] 9.3 One automation (GitHub `issue_labeled`), one scorer (`scope`), one benchmark suite + 2 tasks, one skill, one runner
- [ ] 9.4 `routing.yaml` mapping stages to model/harness
- [ ] 9.5 A second variant `factories/example-lights-off` differing only in gates/mergePolicy (for diff demo)

## 10. Tests & CI

- [ ] 10.1 Unit tests: schema refinements, gates resolver, diff engine, hash stability
- [ ] 10.2 Round-trip test: `export → import → export` byte-identical on both example factories
- [ ] 10.3 Negative tests: each validation error code has at least one fixture
- [ ] 10.4 `bun test` + `bun run typecheck` wired into a `scripts/ci.sh`
- [ ] 10.5 Snapshot test of canonical output for `factories/example`

## 11. Wrap-up

- [ ] 11.1 Update `docs/STATUS.md` (Phase 1 complete, Phase 2 next)
- [ ] 11.2 Add ADR-007 (definition schema v1alpha1) and ADR-008 (semantic diff + canonical form)
- [ ] 11.3 `openspec validate add-factory-definition-schema` passes
- [ ] 11.4 Commit + tag `factory-v0` (bootstrap definition)
