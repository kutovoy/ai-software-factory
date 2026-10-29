---
name: factory-definition
description: Authors, edits and validates a factory definition in this repo — the git-versioned tree of factory.yaml, agents, automations, scorers, benchmarks, skills and routing. Use when creating or changing a factory, when a run needs a new agent/scorer/benchmark, or when validating a definition before a version is pinned.
license: MIT
compatibility: opencode
metadata:
  author: software-factory
  version: "1.0"
  spec: openspec/changes/add-factory-definition-schema/specs/factory-definition/spec.md
---

# Factory Definition

A factory is **code in git**, not rows in a database. The DB only indexes it. Every run, score and
benchmark records the `definitionCommit` it executed against.

**Authoritative sources — read them, don't trust this summary:**
- `docs/ARCHITECTURE.md` §2 — the shape, the root manifest example, gate resolution, versioning
- `openspec/changes/add-factory-definition-schema/specs/factory-definition/spec.md` — normative
  requirements and scenarios (validation rules, round-trip, diff, version pinning)
- `openspec/changes/add-factory-definition-schema/design.md` — the decisions and their rationale

## When to Use

- Creating a new factory under `factories/<name>/`
- Adding or editing an agent, automation, scorer, benchmark, skill or routing rule
- Validating/formatting a definition before `factory version` pins it
- Debugging a validation failure or a non-canonical export

## Layout (path is identity)

```
factories/<name>/
  factory.yaml
  agents/<agent>/agent.md            # role, model|harness, runner, tools, secrets, mcpServers,
                                     #   spawnableBy, idleTimeoutMinutes
  automations/<auto>/automation.md   # triggers{provider,event,filter,schedule}, enabled, agent,
                                     #   execution overrides, per-stage gates
  scorers/<scorer>/scorer.md         # labels[{value,description?,score}], passingScore, samplingRate,
                                     #   judgeModel, selfImprovement
  benchmarks/<suite>/suite.yaml      # + tasks/<task>.yaml, startingRepoRefs = full 40-char SHA
  skills/<skill>/SKILL.md
  runners/<runner>.yaml
  routing.yaml                       # stage → model/harness rules
  packs.lock                         # placeholder; pack imports are Phase 5+
```

Rules that bite:

- **The resource name is its path.** Never repeat `name:` in a resource's frontmatter — renaming means
  moving the file. Two files resolving to the same kind+name is a validation error.
- **Only the directories above are allowed.** A stray file anywhere else fails validation with the path
  and the allowed locations. Don't put scratch notes in a factory tree.
- **Markdown frontmatter must start at byte 0**, `---` delimited. The body is instructions for the agent;
  it is preserved verbatim and is not parsed as config.
- **`skills/<skill>/SKILL.md` inside a factory is a definition resource**, distinct from
  `.opencode/skills/` which are the skills *this* agent loads.

## Root manifest

`schemaVersion` (currently `v1alpha1`), `name`, `repositories[{owner,name}]`, `agentDefaults`, `gates`,
`mergePolicy` are required. See ARCHITECTURE §2 for a full example; don't invent fields that the schema
doesn't have.

**Inference selection is exclusive.** Anywhere inference is chosen — `agentDefaults` and every agent —
declare exactly one of:

```yaml
model: gpt-5-codex                       # OpenAI-compatible model id
harness: {type: opencode, model: ${FACTORY_MODEL}}   # or a harness + model
```

Both, or neither, is a validation error. `harness.auth.source: managedSecret` requires `secretName`, and
that secret must appear in the factory's `secrets` list. Secrets are referenced **by name** and resolved
at run time — never inline a key, never log one.

## Gates and merge policy

`gates` maps a stage to `human | agent | policy:<name>`:

```yaml
gates:
  spec: human
  plan: human
  implement: agent
  review: agent
  pr_review: human
  deploy: human
mergePolicy: auto_on_green   # human | auto_on_green | auto_after_n_approvals | disabled
```

- Resolution precedence is **automation override → factory.gates → global default**. Resolution is a pure
  function (`resolveGate` / `resolveAllGates`) — don't reimplement it in prose or in an agent prompt.
- "Lights off" means every stage resolves to `agent` **and** `mergePolicy` is `auto_on_green` or
  `auto_after_n_approvals`. The resolver reports `fullyAutonomous` and flags that a benchmark gate is
  required before autonomy may be enabled. Don't claim autonomy without both conditions.
- `mergePolicy` is a separate dial from `gates`: gates decide who approves a stage, merge policy decides
  whether a green change merges itself.
- A global kill switch flips everything back to `human`. Design automations so that this works.

## CLI

Once `packages/cli` lands (tasks 7.x), from the repo root:

```bash
bun run factory validate <dir> [--json]        # exit 0/1; errors as {code,file,pointer,message}
bun run factory export <dir> --out <dir> [--check]   # canonical write; --check fails if not canonical
bun run factory import <dir>                   # parse + validate (no DB writes)
bun run factory diff <a> <b> [--json] [--exit-code]  # semantic added/removed/changed
bun run factory fmt <dir>                      # rewrite in canonical form
bun run factory version <dir> [--allow-dirty]  # print JSON version record
```

If the CLI is not implemented yet, validate by hand against the spec scenarios and say so explicitly —
do not report a check as passing when no check ran.

## Canonical form and round-trip

- `export` → `import` → `export` must be **byte-identical**: YAML keys sorted, two-space indent, trailing
  newline, stable frontmatter key order. Never hand-edit into a shape `fmt` would change.
- Version = git commit SHA (+ optional `factory-vN` tag) + content hash of the tree. `version` fails on a
  dirty worktree unless `--allow-dirty`, in which case the version is marked dirty.

## Validation errors

Every failure carries `code`, `file`, `pointer` (JSON pointer to the offending value), and `message`, in
that order. When reporting a failure to a user, quote all four — never paraphrase away the pointer. Use
`--json` when another agent or CI will consume the output.

## Workflow

1. Read the spec section you are changing; check `openspec list` for an in-flight change that owns it.
   Edit files under `factories/<name>/` only — schema/loader/CLI changes belong in `packages/`.
2. `factory fmt`, then `factory validate`; fix by pointer, not by guessing. `export --check` confirms
   canonical output.
3. For a version bump: `factory diff <old> <new>` — review added/removed/changed resources, especially
   gate and `mergePolicy` changes (they change who can approve). Then `factory version`, record the
   commit, and benchmark before promoting a candidate to active.
4. Update `docs/STATUS.md` if the phase's definition surface changed.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Declaring both `model` and `harness` | Pick one; exclusivity is enforced |
| Putting a helper file in the factory tree | Move it out; unknown paths fail validation |
| Treating the UI as truth | Definitions round-trip to files + a commit, always |

## Verification

- [ ] `factory validate <dir>` exits 0 (or the limitation is stated explicitly)
- [ ] `factory fmt` produced no further changes
- [ ] `factory export` → `import` → `export` is byte-identical
- [ ] `model` xor `harness` holds at every inference site; secrets referenced by name only
- [ ] Every gate value is `human`, `agent`, or `policy:<name>`; `mergePolicy` is one of the four
- [ ] If autonomy is claimed: all gates `agent` **and** a valid `mergePolicy` **and** a benchmark gate
- [ ] `docs/STATUS.md` updated when the definition surface changed
