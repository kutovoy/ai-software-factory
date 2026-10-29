# Software Factory Ecosystem Research

Captured 2026-10-28. Claims grounded in the URLs cited inline. Companion: `research/talks.md`.

---

## A. Gas Town / Gas City (Steve Yegge)

Sources: https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04 ·
https://steve-yegge.medium.com/welcome-to-gas-city-57f564bb3607 ·
https://github.com/gastownhall/gastown (`README`, `docs/glossary.md`, `docs/agent-provider-integration.md`) ·
https://github.com/gastownhall/gascity (`docs/getting-started/how-gas-city-works.md`,
`coming-from-gastown.md`, `docs/guides/understanding-packs.md`)

### A.1 What it is

Gas Town (Jan 2026) coordinates multiple CLI coding agents (Claude Code, Codex, Gemini, Copilot, Cursor,
opencode, Kiro, Amp…) via tmux + git worktrees, persisting work state in git-backed hooks. Gas City (v1.0,
Apr 2026) is that machinery extracted into an MIT orchestration-builder SDK: "Gas Town, but torn apart and
rewritten from the ground up as an SDK for building your own dark factories… any topology."

Three role-agnostic pieces of plumbing: **Orchestrator** (runs formulas, drives bead graphs, reconciles
agents), **Bead store** (durable work surviving crashes), **Event bus** (append-only, monotonic seq). The
loop closes through *shared state*, not callbacks: the orchestrator starts/stops sessions but reads
progress from beads + events — which is why work survives a crash on either side.

### A.2 Role taxonomy, and what Gas City did to it

| Role | Level | Job | Gas City equivalent |
|---|---|---|---|
| **Mayor** | town | Planner/coordinator; human's contact point; creates convoys, slings work | configured agent + coordinating prompt |
| **Crew** | rig | Long-lived named agent (or human workspace), persistent context | persistent named agent — an *operating style* |
| **Polecat** | rig | Ephemeral worker: persistent identity, ephemeral session, isolated worktree | scalable pool (min/max active sessions) |
| **Witness** | rig | Per-rig lifecycle monitor: stuck detection, nudge/handoff, cleanup | events + waits + formulas + scale config |
| **Refinery** | rig | Per-rig merge queue: batches MRs, gates, Bors-style bisect | a workflow step / order |
| **Deacon** | town | Continuous patrol across rigs; dispatches Dogs | orchestrator health patrol + thresholds |
| **Dogs** | town | Infrastructure workers (Boot = Dog that checks the Deacon every 5 min) | exec orders (no LLM needed) |
| **Overseer** | town | Final escalation target above Mayor | human / escalation agent |
| **Hook** | agent | Pinned bead = the agent's work queue | bead + session metadata |

Key move: **the orchestrator hardcodes zero roles.** No built-in "manager"/"reviewer"; a role is prompt +
scope + provider in a pack. The Gas Town pantheon survives only as an *example pack*.

### A.3 Work flow: beads → convoys → formulas → molecules

- **Bead** — atomic git-backed work unit in Dolt, *and the universal record type*: tasks, mail, sessions
  and convoys are all beads differing only by `type`. `open → in_progress → closed`; IDs `prefix-xxxxx`.
- **Convoy** — container bead grouping related beads so a batch tracks as one unit.
- **Formula** — TOML template (`[[steps]]` + `needs`). Applying it compiles a DAG and materializes beads;
  the run is then independent of the file and any session.
- **Molecule** — instantiated formula; *wisps* (ephemeral) vs *poured* (sub-wisps, checkpoint recovery).
- **Sling** — dispatch that creates *and* routes in one motion. **Order** — automates *when* a formula runs
  (cooldown | cron | condition | event | manual). **Hook** — the agent's pinned bead queue.
- **Nudge / handoff / seance** — real-time message; session refresh on context exhaustion; querying
  predecessor sessions via `.events.jsonl`.
- **Escalation** — severity-routed (P0/P1/P2) blocker bead: Deacon → Mayor → Overseer.
- **Scheduler** — capacity governor (`scheduler.max_polecats`) against API rate limits.

Two invariants worth stealing verbatim: **GUPP** — *"If there is work on your Hook, YOU MUST RUN IT"*
(agents self-start from durable state); **NDI** (Nondeterministic Idempotence) — the *outcome* converges
even though each run is unreliable.

Canonical loop (MEOW): tell Mayor → decompose → convoy of beads → sling → agents work hooks → Refinery
merges → convoy closes → Mayor summarizes.

### A.4 Supervisor plane

```
Daemon (Go, heartbeat 3 min) → Boot (triage) → Deacon (patrol all rigs) → Witnesses & Refineries
```

**Witness** detects stuck agents, nudges/hands off, delegates rather than implements. **Deacon** patrols,
dispatches Dogs, escalates what Witnesses cannot fix. **`gt feed --problems`** health states: GUPP violation
(hooked work, no progress), Stalled, Zombie (dead tmux), Working, Idle (`n` nudge, `h` handoff).
**Refinery**: `gt done` → branch + MR bead → batch → gates on merged stack → green: merge; red: bisect to
isolate the failing MR. **Polecats never push to main.** **OTEL**: every operation emits logs/metrics
(`gastown.done.total`, …) to any OTLP backend.

Gas City replaces standing roles with **reconciliation**: desired (packs) vs running sessions; stall
detection, restart-with-backoff, scaling, order evaluation, GC of ephemeral run beads.

### A.5 Packs as declarative topology

```
review-pack/
  pack.toml                 # [pack] name/schema/version; [imports.*]; [agent_defaults]
  agents/reviewer/agent.toml   # scope, provider, prompt_template, min/max_active_sessions, scale_check
  agents/reviewer/prompt.md    # the agent's entire behavioural spec
  formulas/review.toml         # steps + needs edges
  orders/                      # cron / cooldown / condition / event triggers
```

- **Imports are namespace-qualified**: `[imports.gc] source = ".../tree/main/gascity"` yields `gc.planner`
  (city) or `checkout-service/gc.planner` (rig). Two packs can both define `worker` without collision.
- **Durable source, not registry handle**: you commit a browser-dereferenceable tree URL; `main:gascity` is
  local discovery only; `packs.lock` pins the exact SHA.
- **Patches, not forks**: `[[patches.agent]] name = "review_tools.reviewer"`; `[agent_defaults]` only fills
  blanks. Deterministic load order: city → imported packs → city imports → rig imports → overrides →
  pack globals → defaults.
- **Credentials secret-by-pointer**: `helper = "gh auth token"` or `token_env = "GC_GIT_TOKEN"`, never a
  literal; gc rejects `user:token@` URLs because they leak into `city.toml`/`packs.lock`/cache.
- **Pools** scale on a `scale_check` query between min and max active sessions; on restart the orchestrator
  **adopts** live sessions (session bead per session) rather than respawning.

### A.6 Auditability and versioning

**Dolt** = git-for-data: every bead mutation is a commit; diff, branch, clone, query the whole history of
agent actions. Yegge: "tracking every step taken by any agent in a database with git version history…
forensics and auditing capabilities are unparalleled." **Events** are immutable, append-only, monotonic seq,
replayable. **Bead lineage** gives provenance: convoy → bead → session → MR → merge. **Wasteland** federation
(DoltHub) posts/claims work, accepts completion *with evidence URL*, and pays portable reputation via
multi-dimensional stamps. **Formulas are a versioned inventory of every automated business process.**

### A.7 How agents review each other

Adversarial group structures are the point, not an add-on. **Refinery** is a mechanical gate (tests + bisect),
not an LLM opinion. **Escalation** routes disagreement upward instead of letting an agent spin. **Witness**
reviews *process* (is it progressing?) while reviewers review *artifacts*.

### A.8 The "always ≥2–3 agents per pack" argument

Verbatim (*Welcome to Gas City*):

> "You should almost never deploy a single-agent pack for a real business process. The reality is that any
> agent can go temporarily insane, at any time, and make a bad call. No matter how smart they are. We know
> now that hallucinations and false memories and forgetting are baked mathematically into all memory
> systems; there's no avoiding it. So you should never just have one coding agent managing a piece of
> infrastructure… You should always have at least two or three working together on a little crew."

Mechanism: *"Adding that second agent, much like a second hash function, dramatically decreases the chance of
some sort of collision."* And the dial: *"Reliability, friends, is a dial… More rounds of review, more
backstops, more guardrails, more judges."* He caps it: not for medical or navigation systems in 2026.

**Transferable rule: no singleton stage that can merge or ship.** Minimum topology = producer + independent
checker + gate.

### A.9 Reusable vs overkill

**Reusable:** six primitives (Agent/WHO, Bead/WHAT, Formula/HOW, Rig/WHERE, Pack/CONFIG, Event/OBSERVE);
bead as universal record; formula → DAG → beads so runs outlive sessions; pack + imports + lockfile + patches
+ defaults (exactly "definitions as code, cloneable, diffable"); reconcile-to-desired-state supervisor; adopt
live sessions; event log with seq; pools with `scale_check`; severity escalation; bisecting merge queue;
capacity governor; ≥2–3 crews; reliability-as-a-dial.

**Overkill:** **Dolt as a hard dependency** (Postgres + git-versioned JSON + JSONL gets 90% at 10% of ops);
**tmux as substrate** (our runners are headless); **the full pantheon as types** (Gas City calls them
"examples, not platform law"); Wasteland federation; 20–50 concurrent agents on day one; seance/forking
heuristics; Go + ICU + Bazel.

---

## B. Harness² (Google Research, arXiv 2610.14224)

Sources: https://github.com/google-research/harness2 (`README`, `docs/SETUP.md`, `docs/EXPERIMENTS.md`,
`harness2/config.py`, `harness2/core/library.py`, `harness2/core/context.py`) ·
https://arxiv.org/abs/2610.14224 · https://arxiv.org/html/2610.14224v1

Xu, Chen, CuiZhu, Dalvi Mishra, Ming, Yu, Han, Lee, Pfister (Google Cloud AI Research + Northwestern).
Apache 2.0; **not an officially supported Google product**.

### B.1 Core idea

Agent = Model + Harness. Weights stay **frozen**; the harness improves recursively on two levels:
**task-level** (refine the execution harness for the current task via contrastive Propose→Probe→Compose,
no ground truth) and **harnessing-level** (extract lessons into a persistent *improvement harness*, i.e. a
per-domain library, so future harnessing improves). Central question: *"Can RSI improve both the current
harness and how future harnesses are improved?"* Answer: yes, measurably.

### B.2 The 8 editable components (each a file, so an edit is a diff)

| Group | Component | File | Activation | Definition |
|---|---|---|---|---|
| Context | C1 System prompt | `systemprompt.md` | every call | persona + top-level procedure |
| | C2 Guardrails | `guardrails.md` | every call | hard constraints regardless of task/tool |
| | C3 Memory | `LongTermMEMORY.md` | every call | durable domain facts across tasks |
| | C6 Skills | `skills/<n>/SKILL.md` + scripts | skill tool | specialist procedure, loaded on demand |
| Tools | C4 Tool guidance | `tool_descriptions/`, `tool_guidance.md` | every call | when/how to use each tool |
| | C7 Scripts | `scripts/<n>.py` | via bash | deterministic capability, executed not reasoned |
| Orchestration | C5 Subagents | `sub_agents/<n>/AGENT.md` | task tool | delegated worker in its own context window |
| Middleware | C8 Plugin | `plugin/<n>.ts` | inside tool loop | hook that *enforces* behaviour, not instructs |

Under opencode the always-on files are the four above; under Codex the always-on text lives in `AGENTS.md`.
In the *stock* harness every on-demand directory holds only a placeholder naming the lever — "the
placeholder is what lets the editor discover a component exists."

### B.3 Loop 1 — Propose → Probe → Compose

`(H', e', ξ) = Φ(q_t, H, E; R_t)` → successor harness, its execution record, and a step record (references,
candidates, probes, composition decisions, successor execution).

- **Propose** — one reference execution `e0 ~ A(q_t; M, H)` reveals *how* the harness behaves, not whether
  the deliverable is correct. Then two candidates: **INV** (planning, tool use, context management,
  delegation) and **DOM** (domain knowledge, procedures, constraints), each an executable harness.
- **Probe** — run each candidate on the *same task* under matched model/env config; compare trajectory +
  deliverable against the reference → a **behavioural contrast** (mitigated / unchanged / regressed).
- **Compose** — read reference + candidates + diffs + all task-local evidence; merge supported changes,
  revise conflicts, adopt one candidate, or **KEEP_BASE**. Every decision tied to a concrete observation.

Explicitly: **composition is not verification.** "Agreement is support, not independent proof."

### B.4 Parallel vs sequential

- `--k 1` = one contrastive step. **Parallel** = `k` references, `k` INV + `k` DOM candidates, `k` composers
  each receiving the full pool (one population update; `k` = width). **Sequential** = `k` chained steps
  conditioned on prior harness + evidence (`k` = depth).
- **Final selection** (`k>1`) compares **anonymized deliverables** against the request + sources and returns
  an existing output, never synthesizes; picking the unmodified-harness output is explicitly valid.
- Parallel wins at `k=5` (76.5→80.8 WB-code; 79.5→83.4 WB-office); sequential higher at `k=2` on code. Both
  beat every baseline at `k=2` vs baselines at `k=5`.

### B.5 Loop 2 — reflector + improvement harness

1. **Reflect** on `D_t` (references, candidates + probes, composition decisions, result). Lessons are
   retained **only when supported by execution contrasts**; adoption alone proves nothing.
2. **Update** `R_{t+1} = Update(R_t, H*_t, D_t)`. Entry = **full adopted harness tree** + `EXPERIENCE.md`
   (cue / lesson / evidence / confidence) + `INDEX.md`. Executable components retained, not prose summaries.
3. **Reuse** — the next task starts from the **common base harness H0** again, not the previous task's
   tailored harness, but refinement is *guided* by the library. Anti-drift: inheriting a tailored harness
   causes "noisy recursive improvement as task distributions shift."

Verdicts: `helped | hurt | no observed effect | confounded`, and **prefer `confounded`** when several
components changed at once or one rollout is all the evidence. "An invented attribution poisons the library
for every later task." No reusable contrast → `NO_ENTRY`.

### B.6 Learning without ground truth

- Contrast, not correctness. Base rollouts are draws from **one distribution** — read as a set. A failure
  repeating across the base set is a real harness property; a defect in `1/k` is noise, and an edit aimed at
  it is overfitting. A candidate has **one** rollout, so an edit earns its place only when a *specific moment*
  in a trajectory shows the mechanism.
- Judge downside as heavily as upside: "the costliest failure is a run that produces nothing."
- Anti-leak: `assert_no_leak_paths()` rejects benchmark answer-key globs; `assert_no_grader_verdicts()`
  refuses any context tree containing rubric/score markers (`"pass_rate"`, `"deterministic_eval_summary"`…).
  A guard refuses to hand over any working directory containing a grader verdict, rubric or score.
- Invalid trees (skill with no trigger sentence, script that does not compile, missing helper) are retried
  once with the validator message; second failure → inherit the starting tree and record the fallback.

### B.7 Cost model

Per task at budget `k`: **solver rollouts** = `k` base + `2k` candidates + `k` composed = **4k**;
**improver sessions** = `2k` proposers + `k` composers + selector + reflector ≈ **3k + 2**. So `k=1` ≈ 4
rollouts + ~4 sessions; `k=5` ≈ 20 + ~16. Concurrency: `PROPOSER_CONCURRENCY = 2`, `PHASE_WIDTH = 2`,
`--workers N` domains in parallel, tasks ordered *within* a domain. Full LAB stream = 1,143 tasks — use
`--only-domains`, `--max-tasks 1`, `--dry-run`.

Results (single step): **+11.5** WorkBuddy-Bench, **+4.5** JobBench, **+11.8pp** LAB partial; `k=5` adds
+2.9–3.9 / +3.0–4.2 / +2.6–6.7pp. Ablations: −library 3.1/1.8, −scoping 2.9/3.7, −composition 1.6/1.9.
Same model as executor *and* editor still improves (GLM-5 +13.7 LAB) — **no stronger editor needed.**

### B.8 On-disk layout (verified from source)

```
runs/<bench>/<subset?>/<mode>/<domain>/…        # summaries, artifacts, adopted harnesses, judged results
<library_root>/<benchmark>/k<k>-<variant>/<domain>/
  INDEX.md                                      # harness path, why, cue per entry
  harnesses/<task_id>/harness/<rel>             # the FULL adopted component tree
  harnesses/<task_id>/EXPERIENCE.md             # adopted label, components, why, edits, lesson
context/                                        # evidence tree handed to a proposer session
  task.md | source/ | decisions/<label>.md
  rollouts/<label>.md                           # FULL trajectory, no prompt-budget truncation
  deliverables/<label>/INDEX.md                 # names + extracted text (or names-only mode)
  harness/<rel>                                 # the c1..c8 tree being edited
  library/INDEX.md                              # earlier tasks in this domain + full harnesses
  pool/<label>/{harness,harness.diff,rollout.md,produced.md}
MISSION.md                                      # short pointer: "read it — do not answer from this message"
```

Design notes worth copying: evidence served **as files**, prompt is a short pointer, nothing truncated to fit
a prompt; the library is copied read-only and you must **copy a component into `context/harness/`** and
re-verify its facts; every stage writes `decisions/<label>.md`; reproducibility keys = benchmark, executor,
subset, `k`, mode, seed, `HARNESS2_RUNS_DIR`.

### B.9 Transplanting into our factory loop

| Harness² | Our artifact |
|---|---|
| Execution harness `H` | `factories/<name>/` — `factory.yaml` + agents + skills + prompts + automations |
| C1 prompt / C2 guardrails | `agents/<n>/prompt.md` / stage gates + permission policy |
| C3 memory | per-factory `memory/` (durable facts, never task facts) |
| C4 tool guidance / C5 subagents | agent prompts / roster (reviewer, verifier, triager) |
| C6 skills / C7 scripts | `skills/<n>/SKILL.md` + scripts / repo scripts invoked by runners |
| C8 plugin | adapter middleware (redaction, cost caps, tool guards) |
| Reference `e0` → Probe | a run under the current version → same work item re-run on a candidate version |
| Compose | merge candidate diffs into a new factory version (git commit) |
| Selector / Judge | anonymized artifact comparison / `packages/evals` scorers |
| Library entry | `evals/library/<domain>/<run-id>/{factory snapshot, EXPERIENCE.md}` |
| Improvement harness `R` | the *improver* agent definition + prompt + the library |

Loop: run finishes → JSONL + diff + scorer results become `D_t` → **reflector** writes `EXPERIENCE.md` only
if contrasts support it → **proposers** (INV + DOM) open branches editing `factory.yaml`/prompts/skills →
**probe** re-runs the same work item (or a replay fixture) → **composer** merges supported edits → **gate**:
benchmark suite must not regress → merge + tag `factory-vN`. Next task starts from the canonical version +
library guidance, never the previous overfit variant.

Do **not** transplant the Python/Vertex/uv stack, the benchmark adapters, or per-task throwaway harnesses. We
want **per-factory** libraries; the unit of improvement is the versioned definition.

---

## C. Spec-driven development with OpenSpec

Sources: https://github.com/Fission-AI/OpenSpec · https://openspec.dev/docs · https://openspec.dev/docs/cli ·
https://www.bighatgroup.com/blog/openspec-vs-speckit-spec-driven-ai-development/

### C.1 What it is

A lightweight, repo-native spec layer that makes human and agent agree on *what* to build before code. Plain
Markdown, no DSL. Philosophy: "fluid not rigid, iterative not waterfall, easy not complex, built for
brownfield, scalable from personal projects to enterprises." MIT; single binary (no Node) or
`npm i -g @fission-ai/openspec`, `brew install openspec`.

### C.2 Layout

```
openspec/
  config.yaml                      # schema: spec-driven, optional store:, language
  specs/<capability>/spec.md       #   ## Purpose; ## Requirements
                                   #   ### Requirement: X   /   The system SHALL ...
                                   #   #### Scenario: Y    /   - **WHEN** ... - **THEN** ...
  changes/<change-name>/
    .openspec.yaml                 # schema, created, goal
    proposal.md | design.md | tasks.md    # tasks: "- [ ] 1.1" (progress counts checkboxes ONLY)
    specs/<capability>/spec.md     # DELTA (ADDED/MODIFIED/REMOVED/RENAMED)
  changes/archive/2026-08-11-<name>/
```

Delta headers are literal and load-bearing:

```markdown
## ADDED Requirements
### Requirement: Rate limiting
The API SHALL limit each client to 100 requests per minute.
#### Scenario: Client exceeds the limit
- **WHEN** a client sends its 101st request within a minute
- **THEN** the API responds 429
```

`MODIFIED`/`REMOVED`/`RENAMED` match the main spec **by exact requirement header**. Archive refuses a delta
whose `MODIFIED` target is missing; `openspec validate` preflights the merge and reports it as `INFO` (not a
failure, since a sibling change may add the target later).

### C.3 Lifecycle: explore → propose → apply → archive

1. **`/opsx:explore`** — no-stakes thinking partner; reads code, weighs options.
2. **`/opsx:propose <idea>`** — creates proposal, spec deltas, design, tasks. Human reviews *before* code.
3. **`/opsx:apply`** — implement tasks, tick checkboxes.
4. **`/opsx:archive`** — validate, merge deltas into `specs/`, move to `changes/archive/YYYY-MM-DD-<name>/`.

Also `/opsx:update`, `/opsx:sync`, `/opsx:bulk-archive`, `/opsx:verify`, `/opsx:onboard` (expanded profile).

### C.4 CLI that matters

| Command | Use |
|---|---|
| `openspec init [--tools …\|none] [--profile core]` | scaffold `openspec/` + install agent skills/commands |
| `openspec update [--force] [--dry-run --json]` | refresh generated instruction files |
| `openspec list [--specs\|--archived\|--all] [--json]` | changes with progress, or specs with requirement counts |
| `openspec show <item> [--json] [--diff]` | proposal/spec; `--diff` appends per-requirement deltas |
| `openspec view` | one-screen dashboard: draft/active/completed + spec inventory |
| `openspec validate <item>\|--all [--strict] [--json] [--report findings]` | structural check + merge preflight |
| `openspec archive <change> -y [--skip-specs]` | merge deltas, move to archive |
| `openspec new change <name> [--goal]` | create change dir (metadata only) |
| `openspec status --change <id>\|--all [--json]` | artifact completion + the single `Next:` command |
| `openspec instructions <artifact\|apply\|archive> --change <id>` | instruction text the agent runs |
| `openspec config profile\|set\|get\|list` | delivery (skills/commands/both), workflows |
| `openspec store …`, `doctor`, `context`, `workset` | multi-repo beta: plan in a separate repo |

`openspec status` is the resume primitive — it prints `Next: openspec instructions design --change "x" --json`,
so a fresh agent session picks up exactly where the last stopped. Our orchestrator can drive OpenSpec
deterministically instead of guessing.

### C.5 Agent integration

`openspec init --tools <id>` installs **skills + slash commands** into the tool's own directory (`.claude/`,
`.cursor/`, `.agents/`…) for 30+ tools. Delivery configurable (`skills`/`commands`/`both`); core profile ships
`propose, explore, apply, update, sync, archive`. Spelling varies: `/opsx:propose` (Claude), `/opsx-propose`
(Cursor/Copilot), `@opsx-propose` (Amazon Q), `$openspec-propose` (Codex) — `init` prints the right form.
Legacy layouts (`openspec-proposal.md`, OpenSpec markers in `AGENTS.md`) are cleaned up and `update --dry-run`
lists exactly which files move. README guidance: high-reasoning models, clean context before implementation.
**Stores (beta)**: plan in its own repo, shared by `git push`; code repos reference it read-only.

### C.6 OpenSpec vs Spec Kit vs Kiro

| | OpenSpec | GitHub Spec Kit | AWS Kiro |
|---|---|---|---|
| Weight | light, plain Markdown | heavy, rigid phase gates | IDE-locked |
| Iteration | edit any artifact anytime | sequential phases | sequential phases |
| Tooling | 30+ agents, single binary | Python setup, extensions catalog | Kiro IDE only |
| Models | any | any | Claude only |
| Brownfield | first-class | weaker | weaker |

### C.7 Concrete workflow for this repo

Already mandated by `AGENTS.md`: `openspec list` → `openspec show <change> --diff` → `openspec validate
<change>` → implement + tick tasks → `openspec archive <change>` only after tests/behaviour verify the delta.

Rules to enforce in CI and in the factory: specs describe **observable behaviour and contracts**, not
implementation; any change to a stage contract needs a spec delta; `openspec validate --all --strict` in CI
with `--report findings --json` for machines; and the `factory.yaml` schema itself should be specified under
`openspec/specs/factory-definition/` so "definitions as code" has a normative contract.

---

## D. Harness abstraction: opencode and friends

Sources: https://opencode.ai/docs/{server,sdk,cli,agents,acp,permissions,plugins,mcp-servers,rules} ·
https://agentclientprotocol.com/get-started/introduction · https://github.com/ag-ui-protocol/ag-ui ·
https://docs.ag-ui.com/concepts/events · https://github.com/gastownhall/gastown/blob/main/docs/agent-provider-integration.md

### D.1 opencode as first adapter

`opencode` starts a TUI *and* a server; the TUI is just a client. `opencode serve` runs the headless server
alone, publishing an **OpenAPI 3.1 spec at `/doc`** from which the SDK is generated — so our adapter is a thin
mapping layer, not a screen-scraper.

| Area | Endpoints |
|---|---|
| Global / events | `GET /global/health`, `GET /global/event` (SSE), `GET /event` (first `server.connected`, then bus events) |
| Sessions | `GET/POST /session`, `GET/DELETE/PATCH /session/:id`, `/children`, `/todo`, `/init`, `/fork`, `/abort`, `/diff`, `/summarize`, `/revert`, `/unrevert`, `POST /session/:id/permissions/:permissionID` |
| Messages | `GET/POST /session/:id/message`, `POST /session/:id/prompt_async` (204, no wait), `/command`, `/shell` |
| Config/providers | `GET/PATCH /config`, `GET /config/providers`, `GET /provider`, auth flows |
| Tools / MCP / agents | `GET /experimental/tool/ids`, `GET /experimental/tool?provider=&model=` (JSON schemas), `GET/POST /mcp`, `GET /agent` |
| TUI control | `/tui/append-prompt`, `/tui/submit-prompt`, `/tui/execute-command`, `/tui/show-toast`, `/tui/control/next` |

Auth: `OPENCODE_SERVER_PASSWORD` (HTTP basic; username defaults to `opencode`).

**SDK** — `npm i @opencode-ai/sdk`; `createOpencode()` boots server+client, `createOpencodeClient({baseUrl})`
attaches. `client.event.subscribe()` yields an async iterable of SSE events. The `/v2` client uses flat params
and supports **structured output** (`format: { type: "json_schema", schema }`) with validation retries — ideal
for reviewer/verifier stages that must emit machine-readable verdicts.

**CLI** — `opencode run "<prompt>"` headless; flags `--session`, `--continue`, `--fork`, `--model
provider/model`, `--agent`, `--format json`, `--attach http://…`, `--auto` (auto-approve non-denied
permissions), `--dir`, `--variant`, `--thinking`. Also `opencode acp` (ACP over stdio nd-JSON), `session list
--format json`, `export`/`import`, `stats`, `db`, `debug config|agent|skill|paths`.

**Agents/subagents** — `primary` (Build, Plan) vs `subagent` (General, Explore); defined in `opencode.json` or
Markdown at `.opencode/agents/<n>.md` (global `~/.config/opencode/agents/`). Frontmatter: `description`
(required), `mode` (`primary|subagent|all`), `model`, `prompt` (`{file:./prompts/x.txt}`), `temperature`,
`top_p`, `steps`, `permission`, `hidden`. Subagents run in their own context window and return only their
result; `permission.task` globs control which subagents an agent may invoke.

**Permissions** — keys `read, edit, glob, grep, list, bash, task, todowrite, external_directory, webfetch,
websearch, lsp, skill, question, doom_loop`; values `allow|ask|deny` or glob→action maps (`bash: { "*": "ask",
"git status *": "allow" }`); last match wins; wildcards match MCP tools (`"mymcp_*": "deny"`). This is exactly
the primitive our human-gate policy needs.

**Plugins / MCP** — JS/TS plugins hook the tool loop (`tool.execute.before/after`, `session.created`,
`session.compacted`); MCP servers local/remote, OAuth, addable at runtime via `POST /mcp`. Gas Town ships an
opencode plugin that calls `gt prime` on `session.created` — proof context injection via plugin works.

**AGENTS.md** — project + global instructions; also reads `.claude` prompts/skills unless disabled. Useful
env: `OPENCODE_CONFIG_CONTENT` (inline JSON config), `OPENCODE_PERMISSION`, `OPENCODE_DISABLE_PROJECT_CONFIG`,
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`, `OPENCODE_EXPERIMENTAL_PLAN_MODE`.

### D.2 ACP (Agent Client Protocol, Zed)

Open standard (Aug 2025, Zed + JetBrains), **JSON-RPC 2.0 over stdio**, "LSP for coding agents." Editor =
client, agent = subprocess (local or remote). Carries session lifecycle, prompts, **streaming updates**,
**tool calls**, **permission requests**, file edits, plans — so an ACP client gets streaming *and* tool
visibility for free. Implementations: `opencode acp`, `gemini --acp`, Zed, JetBrains, Avante.nvim,
CodeCompanion.nvim (https://zed.dev/blog/acp-progress-report). It is the closest thing to a vendor-neutral
*agent session* protocol: one ACP client drives Gemini CLI, opencode and future agents with the same code path
— a stronger abstraction target than per-vendor CLI flags.

### D.3 AG-UI (agent ↔ frontend)

Open, event-based protocol standardizing how agents stream to user-facing apps. ~16 event types over
SSE/WebSocket: run start/finish, text message start/content/end, **tool call start/args/end**, state
snapshot/delta, messages, raw. Integrations: CopilotKit, Pydantic AI, Microsoft Agent Framework, AWS. It is a
*frontend* contract, not a session contract: adopt its vocabulary for our web UI while the backend speaks
adapter-native protocols. Do not confuse it with ACP — AG-UI ends at the UI, ACP ends at the editor.

### D.4 MCP

Tools/resources/prompts for *tool* access; not a session protocol (it says what an agent *can call*, not how a
session starts, streams, or asks permission). Use it for integrations (GitHub, Sentry, Linear, Postgres) and
expose the factory itself as an MCP server (Warp's "Factory MCP").

### D.5 CLI-wrapping (universal fallback)

| Harness | Headless invocation | Streaming/structured | Resume |
|---|---|---|---|
| opencode | `opencode run --format json --session <id>` or `serve` + SDK | JSON events / SSE | `--session`, `--continue`, `--fork` |
| Claude Code | `claude -p "<prompt>" --output-format stream-json --verbose` | JSONL (deltas, tool_use, tool_result) | `--resume <id>` |
| Codex CLI | `codex exec "<prompt>" --json` | JSONL events | `codex resume <id>` |
| Gemini CLI | `gemini -p "<prompt>"` / `gemini --acp` | text or ACP | `--resume` |
| Generic CLI | `<cmd> "<prompt>"` | stdout text only | none |

Gas Town formalizes this as **four tiers**, the best published graceful-degradation model: **Tier 0** any
terminal CLI via tmux (works, timing-sensitive, no resume); **Tier 1** JSON preset (`command`, `args`,
`process_names`, `session_id_env`, `resume_flag`/`resume_style`, `prompt_mode`, `ready_prompt_prefix`/
`ready_delay_ms`, `instructions_file`, `non_interactive{…}`); **Tier 2** hooks (settings.json lifecycle hooks,
JS plugins, informational instructions) for context injection, tool guards, mail; **Tier 3** native API.
Their forward-looking provider contract is essentially our interface:

```
Start(workDir, env) -> Process   IsReady() -> bool   IsAlive() -> bool
SendMessage(text) -> error       GetStatus() -> AgentStatus
InjectContext(ctx) -> error      OnSessionStart(cb)  OnToolCall(cb)
Resume(sessionID) -> Process     SessionID() -> string
ForkSession(id) -> Process       Exec(prompt) -> Result   GetUsage() -> UsageReport
```

Principles to adopt: **loose coupling** (config, not compilation), **discover don't track** (derive liveness),
**ZFC / zero framework cognition** (agent decides; harness is transport), **graceful degradation**.

### D.6 Proposed adapter interface (`packages/adapters`)

```ts
export interface HarnessAdapter {
  readonly id: string;                        // "opencode" | "claude-code" | "codex" | "gemini" | "generic-cli"
  readonly capabilities: AdapterCapabilities; // streaming, toolCalls, permissions, resume, fork, usage, structuredOutput

  startSession(req: StartSessionRequest): Promise<SessionHandle>;
  sendPrompt(h: SessionHandle, parts: PromptPart[], opts?: PromptOptions): Promise<void>;
  streamEvents(h: SessionHandle, signal?: AbortSignal): AsyncIterable<FactoryEvent>;
  cancel(h: SessionHandle, reason?: string): Promise<void>;
  resume(h: SessionHandle, sessionRef?: string): Promise<SessionHandle>;
  fork?(h: SessionHandle, atMessageId?: string): Promise<SessionHandle>;

  respondToPermission(h: SessionHandle, requestId: string, decision: PermissionDecision): Promise<void>;
  listAgents(h: SessionHandle): Promise<AgentDescriptor[]>;
  getDiff(h: SessionHandle): Promise<FileDiff[]>;
  getUsage(h: SessionHandle): Promise<UsageReport>;
  dispose(h: SessionHandle): Promise<void>;
}

export type FactoryEvent =
  | { type: "run.started"; runId: string; harness: string; model: string }
  | { type: "message.delta"; role: "assistant"; text: string }
  | { type: "message.completed"; role: "assistant"; text: string }
  | { type: "tool.call.started"; callId: string; name: string; args: unknown }
  | { type: "tool.call.args.delta"; callId: string; delta: string }
  | { type: "tool.call.completed"; callId: string; result: unknown; ok: boolean }
  | { type: "permission.requested"; requestId: string; action: string; detail: unknown }
  | { type: "file.edited"; path: string; diff: string }
  | { type: "artifact.produced"; path: string; kind: string; bytes?: number }
  | { type: "usage.updated"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "run.completed"; status: "ok" | "error" | "cancelled"; summary?: string };
```

Mapping: **opencode** native (`POST /session` → start, `prompt_async` → send, `/event` → stream, `/abort` →
cancel, `/session/:id/permissions/:id` → respond, `/session/:id/diff` → getDiff, `/session/:id/fork` → fork,
`/agent` → listAgents). **Claude Code** spawn `-p --output-format stream-json`, parse JSONL, `--resume`;
permissions are static flags (`capabilities.permissions = "static"`). **Codex** `exec --json` + `codex resume`.
**Gemini** prefer `--acp`, fall back to `-p` text (`toolCalls: false`). **generic-cli** Tier 0/1 only.

**Which protocols give streaming + tool visibility for free:** 1) opencode server/SDK (best: streaming, tool
calls with schemas, permissions, diffs, usage, structured output); 2) ACP (streaming + tool calls + permission
requests, vendor-neutral); 3) Claude `stream-json` / Codex `--json` (tool calls visible, per-vendor unstable
schemas); 4) AG-UI (gives *our UI* the right shape, but you produce the events); 5) plain stdout (text only).

Build order: canonical union → **opencode native** + **generic CLI** (per `AGENTS.md`) → **ACP** (unlocks
Gemini/others cheaply) → Claude Code/Codex JSONL.

---

## E. Durable orchestration

Sources: https://www.inngest.com/compare-to-temporal · https://www.zenml.io/blog/inngest-alternatives ·
https://www.diagrid.io/infrastructure/10-best-temporal-alternatives-2026 ·
https://www.workflowbuilder.io/blog/human-approval-on-temporal ·
https://docs.temporal.io/ai/cookbook/human-in-the-loop-python ·
https://temporal.io/blog/orchestrating-ambient-agents-with-temporal · https://www.restate.dev ·
https://www.dbos.dev · https://trigger.dev · https://www.windmill.dev

### E.1 Requirements

Per work item (bug → PR): state spanning hours/days surviving worker+API restarts; **HITL gates** that wait
indefinitely and resume on an external decision; retries with backoff around flaky tools/models; timers
(stuck detection, SLA escalation); fan-out/fan-in (parallel reviewers, parallel probes); per-run
observability; multi-tenant isolation later; TS on a Mac today, cloud tomorrow.

### E.2 Comparison

| | **Temporal** | **Inngest** | **Restate** | **DBOS** | **Trigger.dev** | **Windmill** |
|---|---|---|---|---|---|---|
| Model | deterministic workflow + activities, history replay | event-driven functions, `step.run()` memoization | durable services / Virtual Objects, journal replay | Postgres-backed library, step memoization | TS tasks with `waitpoint`s | scripts + flows (Rust engine, Postgres queue) |
| TS SDK | mature, first-class | excellent DX | good, code-first | good | best DX | scripts; less agent-native |
| HITL | **Signals + Updates + `wait_condition`**, durable months | `step.waitForEvent()` | durable promises / awakeables | `send`/`recv` | `waitpoint.token` | approval/suspend steps |
| Timers | durable timers + Schedules | `step.sleep` | durable timers | `DBOS.sleep` | `wait.for` | sleep/schedule |
| Retries | per-activity policies + heartbeats | per-step | automatic | per-step | per-task | per-step |
| Observability | **Web UI, full event history**, search attributes, List Filters | run UI, less deep | UI + journal | Conductor + Prometheus | run dashboard, traces | run viewer |
| Multi-tenant | **Namespaces** + search attributes | limited | key-based isolation | partitioned queues | `concurrencyKey` | workspace/queue |
| Self-host | cluster + Cassandra/Postgres/MySQL/SQLite | yes (SSPL) | **single binary** | **none needed** (Postgres only) | yes | **easy** (Postgres + workers) |
| Cost | self-host free; Cloud ~$100/mo | per-step billing | free OSS; Cloud ~$75/mo | free OSS; Pro $99/mo | Free/$10/$50 + per-second + per-invocation | free OSS / cloud |
| Solo Mac | `temporal server start-dev` + worker | cloud-first, local dev server exists | one binary, trivial | zero new infra | cloud-first | docker compose |

- **Temporal** is most complete for run search, isolation and identity. The price is determinism: LLM and tool
  calls must live in **activities**, so the workflow is "activity: run one agent turn / one runner session",
  not "workflow: the agent loop". That is actually the right shape — the harness owns the loop, Temporal owns
  orchestration around it.
- **Inngest**'s per-step economics punish chatty loops: a 20-turn agent with one model + one tool call per turn
  ≈ **41 billable executions** per run. Step boundaries become a cost decision.
- **Restate** is the sleeper: **Virtual Objects** = one keyed, single-threaded durable actor per session/work
  item — an exact map onto "one live agent session per work item", with automatic idempotency and single-binary
  self-host. Weaker ecosystem/UI.
- **DBOS** is lowest-friction if we refuse new infra (durability in the same Postgres); downside is checkpoint
  volume, large artifacts in Postgres, no Temporal-grade run search.
- **Trigger.dev** has the nicest TS DX and real `waitpoint` HITL + `concurrencyKey` tenant queues, but is
  cloud-first and bills per invocation + per second.
- **Windmill** is excellent for script/flow automation and self-hosting, but script-centric; long-lived agent
  sessions with signals are awkward.
- Adjacent: **Hatchet** (best multi-tenant fairness, CEL concurrency keys, $500/mo cloud entry, 3-day retention
  on team plan); **Kitaru/ZenML** (Python-only agent runtime with checkpoint replay + `wait()`).

### E.3 HITL mechanics (Temporal)

```ts
const decision = await workflow.condition(() => approvals.length > 0, "7 days");
// signal handler pushes { gate: "pr-review", verdict: "approve" | "reject", notes } into approvals
```

Better for our UI: **Updates** (request/response, validated, returns a result synchronously) so the web app can
confirm "your approval was recorded". Escalation timers are `workflow.sleep()` racing the condition; replay
after crash is automatic. Temporal ships a human-in-the-loop cookbook for exactly this. The ambient-agents
pattern is also worth copying: each agent is a long-running Workflow waiting for Signals, Queries expose
state, and **tools are implemented as Workflows** — so every tool call is durable and auditable and the UI can
watch the event history step by step.

### E.4 Recommendation

**Primary: Temporal** — one Workflow per work item, child Workflows per stage, Activities wrapping runner and
model calls. HITL gates/timers/retries/replay are native; event history *is* the per-run audit trail (mirror to
JSONL/Postgres for the UI); namespaces + search attributes give the multi-tenant path; TS SDK is mature and
`temporal server start-dev` + a Bun worker is a viable solo-Mac loop; it does not care which harness or model we
use (Activities are RPC to runners). Dev is trivial; real self-hosting is a cluster — for a solo dev that means
**Temporal Cloud** (~$100/mo) until there's a reason to self-host.

**Fallback for MVP (weeks 1–4):** Postgres tables `runs`/`run_steps`/`run_signals` + a Bun worker loop + SSE
(~500 lines). Design interfaces so the swap is mechanical: `startRun`, `signalGate`, `awaitGate`, `recordStep`,
`emitEvent`. **Runner-up spike:** **Restate** for single-binary ops + per-session Virtual Objects; **DBOS** for
zero new infrastructure if artifacts stay out of Postgres. Do **not** use Inngest for the core loop (per-step
cost, step-shape mismatch) or Windmill as the orchestrator.

---

## F. Competitive landscape

List price as of 2026-10-28; indicative, verify before quoting.

| Product | Factory loop | Definitions as code? | Model/harness agnostic? | Pricing |
|---|---|---|---|---|
| **Factory.ai ("Droids")** https://factory.com | Signals (bug/feedback) → Droids across SDLC; Missions; sovereign on-prem | Config in product; not git-first IaC | Yes — model-agnostic + sovereign explicit | Pro $20, Plus $100, Max $200; Teams $60/mo + $40/seat; enterprise |
| **Tessl** https://tessl.io | Spec registry + skills registry + Tessl Agent + Launch | Yes — specs/skills versioned | Largely yes | Not public; free tier + enterprise |
| **Codegen** https://codegen.com | Ticket → cloud sandbox → PR | Partial | Limited model choice; closed harness | Per-seat + usage |
| **Cognition / Devin** https://devin.ai | Autonomous SWE agent + Devin Desktop; ACU-based | No | Limited model menu | $20 entry (ACU-metered), $80/mo team + $40/seat |
| **OpenHands** https://openhands.dev | OSS agent platform: any agent (Codex/Claude), automations, self-host | Yes — config + repo | **Yes, strongest**: any model via LiteLLM, any agent | OSS free; Teams $500/mo up to 10 (+$50/seat) |
| **Sweep** | Pioneered issue→PR automation | n/a | n/a | Historical; largely superseded |
| **Graphite Diamond** https://graphite.dev | AI code *review* only (stacked PRs + Diamond) | No | Model-agnostic reviewer | ~$15/active contributor/mo add-on |
| **Warp Factories** https://www.warp.dev/factories | Inputs → triage → spec → implement → review → verify → monitor | **Yes — `factory.yaml`**: agents, runners, repos, automations, integrations, scorers; "Terraform for factories" | **Yes** — any model, any harness, self-hostable compute | Enterprise / early access |
| **Google Jules** https://jules.google | Async agent in a VM; issue → PR | No | Gemini-only | $0–$125/mo |
| **AWS Kiro** https://kiro.dev | Spec-driven IDE: requirements → design → tasks + hooks | Specs as repo files | Claude-only | Free 50 credits; Pro $20, Pro+ $40, Pro Max $100, Power $200 |
| **GitHub Copilot coding agent** | Issue → agent in Actions → PR | Partial: repo instructions + workflows | Model menu (Claude/GPT), harness fixed | Included in Copilot plans (~$10/$19/$39 seat) |
| **Cursor background agents** | Cloud agents on branches, parallel | `.cursor/rules` + config, not a full factory | Model menu; closed harness | Included in Pro $20 + usage |
| **StrongDM factory** (blog) | Lights-off: specs + scenarios, no human review | Yes | n/a | Internal; "≥$1,000 tokens per human engineer" |

**Patterns.** (1) Everyone converged on the same loop: signal → triage → spec → implement → review → verify →
ship → monitor; differentiation is *where the human sits* and *whether the factory is code*. (2) Only three are
genuinely factory-as-code: Warp, Tessl, OpenHands. (3) Model-agnostic is table stakes; harness-agnostic is rarer
(Warp supports open-weight harnesses + Claude Code + Codex; OpenHands runs any agent). (4) Self-improvement is the
new battleground: Warp (scorers + replay + benchmarks + outer-loop skill PRs), Tessl (Kikimora), Factory
(agent-readiness pillars). (5) Metrics moved past PR count: signal-to-production time, interventions/PR, cost/PR,
manual takeovers, human review comments, PRs started without a human. (6) The failure mode is documented:
Horthy's lights-off experiment collapsed on maintainability; Faros shows incidents/PR +242.7% at high AI adoption
— lights-on-by-default is evidence-backed.

**Our niche.** Open + harness-agnostic + definitions-as-code + self-hostable + local-model-friendly: no closed
product offers all five (OpenHands is closest but agent-centric, not factory-centric). Nobody ships a clean
"human gate per stage, globally configurable" primitive for a solo dev. And Harness²-style improvement wired to
*factory definitions* — Warp improves skills via PRs, Harness² improves a harness per task; we improve the
*factory* per work item, gated by evals and versioned in git — is a genuinely novel combination.

---

## Recommended architecture primitives

~20 primitives, each traced to its source. These become the domain model in `packages/core` and the nouns in
our UI.

1. **Factory definition as code** — `factory.yaml` + `agents/` + `automations/` + `scorers/` + `skills/`,
   git-versioned, diffable, cloneable, exportable. *Warp factory-as-code; Gas City `pack.toml`.*
2. **Pack/import with lockfile + patches + defaults** — compose from shared packs without copying;
   namespace-qualified names; `packs.lock` pins revisions; patches override locally. *Gas City packs.*
3. **Work item as a universal record** — one type with typed subtypes (task, message, session, convoy,
   approval), prefixed stable ID, lineage links. *Gas City bead.*
4. **Stage graph compiled from a declarative template** — steps + `needs` edges compile to a DAG, materialize
   as work items, run outside any session. *Gas City formula → molecule; Warp automations.*
5. **Durable run = one workflow per work item** — deterministic orchestration; activities for all
   non-deterministic work. *Temporal.*
6. **Human gate as a first-class primitive** — typed decision (`approve|reject|request_changes`), durable wait
   (days), escalation timer, recorded in the event log; per-stage + global config; lights-on default.
   *Temporal Signals/Updates + HITL cookbook; Gas Town escalation.*
7. **Append-only per-run event log (JSONL, monotonic seq)** — audit trail, UI feed, raw material for
   scorers/self-improvement. *Gas City Event; Warp agent traces.*
8. **Harness adapter interface** — start/send/stream/cancel/resume/permissions/diff/usage + capability flags +
   graceful degradation. *opencode server/SDK; Gas Town provider tiers 0–3; ACP.*
9. **Runner protocol** — lease a sandbox, upload artifacts, heartbeat, kill; tool execution never in the web
   process; local subprocess first, remote worker later. *Warp compute layer; Gas Town hooks/worktrees.*
10. **Agent = prompt + scope + provider + permissions** — a role is configuration, not a class; no hardcoded
    "reviewer"/"manager" types. *Gas City agent ("zero roles").*
11. **Agent pool with demand-based scaling** — `scale_check`, min/max active sessions, shared queue. *Gas City pools.*
12. **Supervisor/reconciler loop** — desired vs running, adopt live sessions on restart, stall detection,
    restart with backoff, health patrol. *Gas City orchestrator; Gas Town Deacon/Witness.*
13. **Capacity governor** — max concurrent agents, per-provider rate limits, pause/resume dispatch. *Gas Town scheduler.*
14. **Merge queue with bisecting gates** — agents never push to main; batch, gate the merged stack, bisect on
    red. *Gas Town Refinery (Bors-style).*
15. **Review committee ≥2 independent reviewers + a judge** — no singleton stage can merge/ship; a second
    reviewer is "like a second hash function." *Yegge's ≥2–3 argument; Factory multi-agent reviews.*
16. **Scorer registry** — deterministic checks + LLM-as-judge + human feedback, per stage and factory,
    versioned rubrics. *Warp scorers/evals; Harness² judge.*
17. **Benchmark suite with replay** — replay real work at its exact initial state, compare factory versions,
    track cost/quality per configuration. *Warp Factory Benchmarks; Harness² reproducibility.*
18. **Experience library per domain** — `INDEX.md` + `EXPERIENCE.md` (cue/lesson/evidence/confidence) + full
    adopted factory snapshot; only evidence-supported lessons retained. *Harness² `core/library.py`.*
19. **Contrastive improvement loop gated by evals** — INV + DOM proposals on branches, probe on the same work
    item under matched conditions, compose, require benchmark non-regression before merge/tag. *Harness²
    Loops 1+2; Warp outer-loop skill PRs.*
20. **Versioned factory releases** — `factory-vN` tags, diffs, rollback, A/B by version; DB indexes, files are
    the source of truth. *Warp factory-as-code; OpenSpec archive.*
21. **Spec layer** — `openspec/specs` + `openspec/changes` + validate + archive; the factory schema specified
    here too. *OpenSpec.*
22. **Secrets by reference** — definitions name a secret, resolved at run time, never in logs or YAML.
    *Gas City `credentials.toml`; our `AGENTS.md`.*
23. **Model routing per stage** — model + harness per agent/stage (cheap triage, strong implement/review),
    tunable in the definition. *Warp model routing; Gas City model selection; Suraj Gupta.*
24. **UI event contract shaped like AG-UI** — canonical event types so the UI is protocol-shaped. *AG-UI events.*

**Build order (first five):** (1) factory definition schema + git round-trip (1, 20, 21) — nothing is testable
until definitions export/diff/import identically; (2) work item + event log + run record (3, 5, 7); (3) opencode
adapter + runner protocol (8, 9) — proves "UI is the harness front-end, tools on runners" end to end; (4) human
gate (6) — the differentiator; (5) scorer + benchmark harness (16, 17) — without it, self-improvement (18, 19)
is unfalsifiable.

---

## Open questions / risks

- **Temporal determinism tax** — agent loops must be activities, not workflow code. Spike one workflow + one
  runner activity + one approval signal before committing.
- **opencode server stability** — `/experimental/*` endpoints and event schemas can change; pin versions, keep
  the canonical union as the stable boundary.
- **Bun + Temporal** — the TS SDK is Node-oriented; verify `bun` worker compatibility early or run the worker
  under Node while the monorepo uses Bun.
- **Supabase + Temporal** — Temporal wants its own persistence; do not share the app's Postgres schema.
- **Harness² is Python + Vertex-first** — re-implement the *method*, not the code: evidence-tree layout, library
  format, "confounded / KEEP_BASE" discipline.
- **Lights-off risk is real** — default lights-on and require a benchmark gate before enabling lights-off per stage.
