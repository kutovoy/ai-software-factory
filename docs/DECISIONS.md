# Architecture decisions (ADR-lite)

One entry per decision that is expensive to reverse. Format: context → options → decision → consequences.
Status: `proposed` | `accepted` | `superseded`.

---

## ADR-001 — Durable orchestration engine

**Status:** accepted (2026-10-28)
**Context:** Agent runs are long-lived (minutes to hours), must survive restarts, need retries, timers,
human-in-the-loop waits, and per-run observability. Solo-on-Mac first, cloud multi-tenant later.
**Options:** Temporal · Inngest · Restate · DBOS · Trigger.dev · Windmill · plain Postgres queue.
**Decision:** **Temporal from day one**, using `temporal server start-dev` locally and the TS SDK.
One Workflow per work item, child Workflows per stage, Activities wrapping runner and model calls.
Postgres remains the read model for the UI (runs/work items/events index); Temporal event history is the
durable execution truth. Migrate to Temporal Cloud when multi-tenant (Phase 6).
**Consequences:** gates use Signals/Updates (native durable waits, days-long); timers give escalation SLAs;
replay gives auditability. Adds a local dev dependency and a worker process; every Activity must be
idempotent. Do not put artifacts in Postgres — object store/disk + references.

---

## ADR-002 — Harness abstraction

**Status:** accepted (2026-10-28)
**Context:** Must be harness-agnostic (opencode first, then Claude Code / Codex / Gemini / generic CLI),
model-agnostic (any OpenAI-compatible endpoint), and must stream tool calls into the web UI because the
UI *is* the harness front-end.
**Options:** embed opencode server in the UI · adapter interface per harness · adopt ACP/AG-UI as wire
protocol · CLI wrapper with structured stdout.
**Decision:** one internal `HarnessAdapter` interface + canonical `FactoryEvent` union. **New Chat always
goes through adapter + runner** — the UI never talks to a harness process directly. Every prompt becomes a
run on a runner, so chat and factory work share one code path, one audit trail, and one permission model.
opencode adapter talks to `opencode serve` (HTTP+SSE) as the reference implementation.
**Consequences:** slightly higher chat latency (runner lease per message); in exchange: full audit trail,
identical semantics for all harnesses, and the ability to move a chat session into a factory run and back.

---

## ADR-003 — Factory definition format & versioning

**Status:** proposed (strongly leaning accepted)
**Context:** Definitions must be diffable, cloneable, comparable across versions, editable by agents,
and exportable/importable as text.
**Options:** DB-first + export bundles · git-backed YAML + DB index · both with bidirectional sync.
**Leaning:** git-backed `factory.yaml` + directory tree, DB only indexes/caches; every run pins a commit
SHA; UI edits produce a commit (or PR) — never a DB-only mutation.
**Decision:** _pending schema confirmation from `research/warp-factories.md` §4._
**Consequences:** enables benchmarks per version, self-improvement as PRs, and rollback.

---

## ADR-004 — Gates model (lights on/off)

**Status:** proposed
**Context:** Humans should be optional but on by default; granularity needed per stage and per automation.
**Options:** global boolean · per-stage enum (`human` | `agent` | `policy`) · per-automation overrides
with global defaults.
**Decision:** gate policy object resolved as `automation override → factory default → global default`,
each gate being `human` | `agent` | `policy:<name>`. Default (lights on) = spec, plan, pr_review = human.
Target capability (lights off) = **every stage agent-gated**, including deploy, with `mergePolicy:
auto_on_green`. Build the full capability in Phase 3, but **enabling** all-agent gates requires a passing
benchmark non-regression gate (Phase 4) — the switch exists earlier, the guardrail ships with it.
**Consequences:** drives inbox semantics, escalation paths, and what "lights off" means for audit. A global
kill switch flips every gate back to `human` and pauses dispatch.

---

## ADR-005 — Self-improvement safety

**Status:** proposed
**Context:** Observer agents may propose changes to prompts/skills/model routes/scorers/automations.
Must not degrade quality or silently rewrite itself.
**Options:** propose-only PRs · auto-merge if eval improves · staged rollout with canary + rollback.
**Leaning:** propose → benchmark against current version on a fixed task set → if improved beyond a
threshold, open a PR (auto-merge only in lights-off mode with a benchmark gate + rollback on regression).
**Decision:** _pending — informed by Harness² mechanics (`research/ecosystem.md` §B)._
**Consequences:** requires benchmark infrastructure before self-improvement can ship.

---

## ADR-006 — Runner isolation

**Status:** proposed
**Context:** Tool execution must not happen in the web process; local Mac + remote workers later.
**Options:** Docker containers · macOS `sandbox-exec` · microVM (Firecracker/Lima) · git worktree +
process jail.
**Leaning:** local runner = Docker (or Lima) with a bind-mounted worktree; remote runner = same image on
a worker host; protocol identical.
**Decision:** _pending._
**Consequences:** affects secret injection, artifact capture, and macOS-specific tooling.

---

## ADR-007 — Definition schema v1alpha1

**Status:** accepted (2026-10-28, Phase 1)
**Context:** We need a format that is diffable, agent-editable, and expressive enough for gates and
model/harness routing — Warp's schema lacks gates, tool allowlists, and version comparison.
**Decision:** `schemaVersion: v1alpha1`. Path is identity (`agents/<name>/agent.md`); Markdown
frontmatter for config, body for instructions; exactly one of `model` or `harness` wherever inference is
selected; `gates` (stage → `human|agent|policy:<name>`) and `mergePolicy` live in `factory.yaml`;
`routing.yaml` collapses Warp's `routers/`; `packs.lock` reserves composition for later.
**Consequences:** schema changes require a version bump + codemod; unknown fields are rejected (no silent
typos); the loader is the only place that parses YAML, so migrations are single-point.

---

## ADR-008 — Canonical form and semantic diff

**Status:** accepted (2026-10-28, Phase 1)
**Context:** Version comparison and self-improvement PRs are only meaningful if formatting noise is absent
and diffs describe behaviour, not text layout.
**Decision:** `export` emits deterministic YAML (sorted keys, 2-space indent, trailing newline) and stable
frontmatter key order; `import → export` must be byte-identical (enforced by tests). `diff` compares parsed
documents and reports added/removed/changed with JSON pointers, plus a human unified rendering.
**Consequences:** agents can rewrite files without churn; `export --check` works as a CI lint; content
hashes are order-independent, so a factory version is stable regardless of filesystem order.

---

## ADR-009 — The harness runs inside the runner

**Status:** accepted (2026-10-28, Phase 2a)
**Context:** ADR-002 says chat always goes adapter → runner, and tools must execute in the sandbox.
**Decision:** `opencode serve` (and any future harness) starts **inside** the run container; the adapter
connects over HTTP+SSE to a mapped port. The API never spawns processes on the host.
**Consequences:** tool isolation is structural, not policy-based. Costs a readiness probe + port mapping
per run; the runner must expose the harness endpoint in its lease handle.

---

## ADR-010 — Postgres is a derived read model

**Status:** accepted (2026-10-28, Phase 2a)
**Context:** The UI needs fast list/detail queries; Temporal is the execution truth.
**Decision:** `runs`, `run_steps`, `events` are written by activities from workflow state and are safe to
rebuild. Losing Postgres loses no run. Blobs never go in Postgres — artifacts are referenced by path+hash.
**Consequences:** every persistence write must be idempotent (`runId+stepId`); a rebuild tool is needed
before we rely on the read model for benchmarks.

---

## ADR-011 — Inference proxy, not credentials in the sandbox

**Status:** accepted (2026-10-28, Phase 2a)
**Context:** The harness inside the runner needs to call models, but inference credentials must never enter
the sandbox (ADR-002/009 and the four-boundary model).
**Decision:** the API hosts an OpenAI-compatible proxy (`/v1/*`). Each run gets a scoped bearer token and a
model allowlist; the proxy injects the real provider credential, streams responses through, records every
attempt, and revokes the token at run end. The runner only ever sees `OPENAI_BASE_URL=<proxy>/v1` and
`OPENAI_API_KEY=<runToken>`.
**Consequences:** adds one hop of latency; the proxy becomes a security-critical component (must not log
prompts by default, must enforce allowlists, must fail closed). Enables per-run cost attribution and makes
provider swaps invisible to harnesses.

---

## ADR-012 — The web console consumes the API only; one event renderer for chat and runs

**Status:** accepted (2026-10-29, Phase 2b)
**Context:** The console could read Postgres, the definition files or a harness directly — all of which
would duplicate domain logic and create a second source of truth. It also has two surfaces that show
the same thing: New Chat and run detail.
**Decision:** `apps/web` is a pure projection of `apps/api`. Server components fetch `API_BASE_URL`
over HTTP; browser-side code only talks to same-origin `/api/*` route handlers, which proxy the API
(SSE included, un-buffered). No DB client, filesystem, harness or runner import exists in the web app.
One `EventStream` renderer + `useRunStream` hook draws both New Chat and run detail, so "chat is a run"
(ADR-002) is true in the code, not just in the docs. Factory pages are read-only: definitions are
edited in git and never written by the UI.
**Consequences:** the API is the only integration seam — no CORS, no duplicated schema knowledge, one
place to enforce auth. Every web feature needs an API projection, and a projection is not a place to
invent defaults: missing data renders as an explicit empty state naming its phase. When a page needs
more definition detail, extend a read-only projection (e.g. `doc` on `/factories/:name/resources`)
rather than reading files in the web process. Adding a second renderer would immediately violate
ADR-002's parity claim and double the streaming test surface.

---

## ADR-013 — Human gates are workflow-level durable waits, never activity-blocking

**Status:** accepted (2026-10-29, Phase 2b fix)
**Context:** Phase 2b E2E runs exposed a scalability defect: `pumpEvents` blocked inside the
activity while it polled Postgres for a permission decision. The worker ran 8 concurrent
activities, so eight abandoned permission-blocked runs consumed every slot and no new run could
start. ADR-001/ADR-004 and `openspec/specs/run-lifecycle` promise that human gates are durable
waits that cost nothing; an activity slot is a cost, and it is the wrong place for a human.
**Options:** keep polling inside the activity (status quo) · make the wait a Temporal Update/Signal
with `condition()` in the workflow · move the decision to a dedicated poller workflow/queue.
**Decision:** `pumpEvents` is a **segment**: it returns as soon as a `permission.requested` event is
emitted (persisted exactly once, in the same activity). The workflow registers a **Update**
(`submitPermissionDecision`, synchronous ack; **Signal** `permissionDecision` as fallback) at
workflow start, then `await condition(...)` on workflow state with no fixed timeout — only a
configurable SLA timer (`PERMISSION_TIMEOUT_MS`, auto-deny + `error`) and a slow cancellation probe
touch the DB. After the decision it runs `respondPermission` and resumes pumping from the last
`seq` against the cached adapter iterator. `POST /runs/:id/permissions/:requestId` keeps its exact
response shape; it records the decision in the read model (UI) and delivers the Update/Signal.
Worker concurrency is env-tunable (`WORKER_MAX_CONCURRENT_ACTIVITY_TASKS`,
`WORKER_MAX_CONCURRENT_WORKFLOW_TASKS`; code default 100/100).
**Consequences:** a permission-blocked run holds no activity slot, so blocked runs cannot starve
the queue; cancellation while waiting is immediate (Signal wakes `condition`, the run ends
`cancelled`, the sandbox is killed). Every future gate (Phase 3 `awaitGate`, child workflows) must
follow this shape. Cost: the decision path depends on Temporal being reachable (a failed delivery
leaves the run to the SLA timer), and a worker restart recreates the adapter session — the pump
re-forwards durable decisions best-effort and deduplicates events by `(runId, seq)`.

---

## ADR-014 — A work item is a durable workflow; the foreman is deterministic control flow

**Status:** accepted (2026-10-29, Phase 3a)
**Context:** Phase 2 proved a single run end-to-end. A factory is a loop over work items that must
survive worker restarts, days-long human waits and repeated stage attempts. Two shapes were possible:
a workflow variable carried in memory (lost on restart, impossible to inspect), or a persisted record
whose workflow is derived from it. Separately, the loop's control flow could be driven by a model
(flexible, nondeterministic, expensive, hard to replay) or by compiled policy.
**Options:** in-memory loop state · persisted work item + derived workflow id · model-driven foreman
that decides the next stage itself.
**Decision:** a work item is a **persisted record**, not a workflow variable: typed
(`task|bug|incident|pr_review`), sourced (`forge|slack|cron|manual`), with lineage (`parentId`) and a
current stage, persisted in Postgres with a stable `wi_<ulid>` id. The workflow id is derived from the
id (`factory-<workItemId>`), so a restart reattaches to the same item. The **foreman is workflow
control flow**, not a model: the stage graph is compiled from the definition (`stages:` or agent
roles) and the next stage is decided deterministically. The foreman *agent* is invoked only for
judgement calls (triage classification, `request_changes` interpretation), with schema-constrained
output, bounded retries, then escalation to a human. Each stage is a child workflow
(`StageWorkflow`), and the parent calls `continueAsNew` after N stages to bound history.
**Consequences:** loop control is replayable and cheap; a stage can be retried or replayed without
re-running the loop; work items are inspectable records the console can project (board, detail,
timeline). Cost: new stage behaviour is a workflow/definition change, not a prompt change; the
judgement model is an injectable boundary (deterministic today, a real model later) and an invalid
output can only escalate, never guess.

---

## ADR-015 — The review committee is advisory; only the ship gate merges

**Status:** accepted (2026-10-29, Phase 3a)
**Context:** A single reviewer is a weak signal and a self-approving agent would collapse the
four-boundary model: agents must never push to the default branch or merge (ADR-002/ADR-009). The
loop still needs structured review evidence to inform a human (or an agent gate under lights-off).
**Options:** one reviewer that approves · N reviewers that approve · N independent reviewers + a
judge producing an advisory verdict, with the gate as the only authority.
**Decision:** the `review` stage fans out to **at least two independent reviewer children** running on
the same commit; each returns a structured findings report (`reviewer`, `severity`, `summary`,
`file?`, `confidence`). A judge merges the reports into one `{verdict, findings[], confidence}`
(`approve|reject|needs_human`), always marked `advisory`. Disagreement, a reject, or fewer reports than
configured resolves to `needs_human` and escalates to the review gate. Nothing merges on a verdict and
no approval is posted to the forge: the **ship gate + merge policy** is the only merge authority, and a
`human` merge policy refuses an automatic ship decision.
**Consequences:** review costs more (≥2 runs + a judge per review stage) and is slower; verdicts are
audit evidence, not permission. The judge is deterministic today (injectable), so calibration against
real reviewers is a Phase 4 benchmark concern, not a Phase 3a claim.

---

## ADR-016 — Score provenance is mandatory; an uncalibrated judge cannot satisfy the benchmark gate

**Status:** accepted (2026-10-29, Phase 4a)
**Context:** Scores are only useful if they are comparable across time and trustworthy. Judge models
drift, rubrics change, and an LLM judge can silently map an output to a nearby label. Without
provenance a score cannot be re-derived; without calibration a judge is an unvalidated opinion. The
loop also needs a hard cost bound: judge calls are the expensive part of measurement.
**Options:** store only `{label, score}` · store model + version + rubric hash + prompt hash + usage ·
add a human-labelled golden set with an agreement threshold and refuse to certify below N.
**Decision:** every score stores `rubricHash` = sha256(rubric body + label set), `judgeModel`,
`judgeModelVersion`, `promptHash` = sha256(system + user prompt), token usage and cost. The rubric
hash is content-addressed: a body or label change produces a new hash and a new score row, while old
scores keep the hash they were produced with. Deterministic scorers run always and cost nothing; judge
scorers are sampled deterministically by `sha256(runId)` (stable across re-runs), gated by cadence, and
bounded by a per-factory daily cap — reaching the cap yields `skipped` with `budget_exhausted` while
deterministic scoring continues. Calibration is a first-class table: a golden set of hand-labelled
runs is re-judged, and the result reports exact agreement, within-tolerance agreement, a per-label
confusion matrix and a pass/fail verdict. Below the configured minimum size the result is
`insufficient_data`, never a lucky pass. A judge score with no passing calibration for its current
rubric hash + model is marked `uncalibrated: true` and is not benchmark-eligible; the scorers and
metrics responses expose the gate state. The `JudgeClient` boundary has a deterministic `stub` (CI,
tests, smoke) and an `openai` implementation for any OpenAI-compatible endpoint; the real path exists
but is unexercised in CI.
**Consequences:** scores are auditable and re-scorable; a rubric change is detectable instead of
silently mixing incomparable numbers. Calibration becomes a prerequisite for benchmark/autonomy
claims (Phase 4b), and the daily cap bounds spend. Cost: judge scoring needs a golden set before it
can be trusted; judge calls are a network dependency outside CI; calibration sets are small, so
verdicts are only as good as the examples.

---

## ADR-017 — Metrics are derived queries over the read model, not event-sourced counters

**Status:** accepted (2026-10-29, Phase 4a)
**Context:** The console needs throughput, cost per PR, cycle time, time to first human review,
touchpoints per PR, automation % and defect rate. Event-sourced counters drift under retries,
replays and backfills, and a counter is impossible to explain when a number looks wrong. The existing
read model (`runs`, `work_items`, `gate_decisions`, `work_item_events`, `run_permissions`) already
holds the raw facts.
**Options:** increment counters on every event · maintain materialized views · compute at read time
from the read model.
**Decision:** metrics are **derived SQL queries computed at read time**, with an explicit window
(`?window=7d|30d|90d`) echoed in the response. Every metric returns `{value, unit, sampleSize,
definition}`; a metric with no data returns `value: null` plus a `reason`, never zero. Cost is
attributed per stage by the stage-run id convention (`run_<workItemUlid>_<stage>_<attempt>`), and
unattributed cost (chat/ad-hoc runs) is reported separately rather than hidden. Defect rate counts
forge-recorded red checks per PR; human PR comments are only counted when the forge backend persists
them (the fake forge does not). No "savings vs human" estimate is produced. If read-time queries get
slow, materialized views are an implementation detail behind the same response shape.
**Consequences:** numbers are explainable and rebuildable from the read model; replaying or backfilling
cannot corrupt them. Cost: queries scan tables per request, so indexes and later materialization
matter at scale; metric definitions are part of the API/UI contract and must change deliberately.

---

## ADR-018 — A benchmark attestation binds definition commit + configuration hash + calibration

**Status:** accepted (2026-10-29, Phase 4b)
**Context:** The autonomy guardrail (`benchmarkGateRequired`) must be satisfiable by evidence, not by
a declaration. A benchmark result is only comparable if it replays the same tasks at the same pinned
revisions with the same model/harness mix; a result from another version or another matrix must not
unlock autonomy. Judges also drift, so a benchmark scored by an uncalibrated judge is an opinion.
**Options:** gate on "a benchmark ran" · gate on the latest pass rate · bind an attestation to
`(factory, definitionCommit, configHash)` and require `passed && calibrationOk`.
**Decision:** every benchmark run records `definitionCommit` (git SHA) and `configHash` = sha256 over
the normalized full (task × configuration) matrix plus `definitionCommit`. A run that passes its
calibrated pass-rate threshold on the **full matrix** writes one attestation keyed by
`(factory, definitionCommit, configHash)` with `{suite, passRate, calibrationOk, passed, createdAt}`.
The autonomy gate accepts only an attestation whose commit + hash match the running version; otherwise
it refuses with `benchmark_attestation_missing`. Changing a configuration, a task set or the definition
invalidates the attestation (a stale attestation never satisfies the gate). A partial matrix run reports
results but cannot attest. The explicit override `{actor, reason}` from Phase 3a remains as an audited
escape hatch, but it is no longer the only way through.
**Consequences:** autonomy claims are reproducible and version-scoped; a model swap or definition edit
requires a fresh benchmark before lights-off can be re-enabled. Cost: benchmarks are the most expensive
operation in the system, guarded by an estimate + confirmation threshold + hard `maxCostUsd` cap.
Attestations are a read-model projection; the definition stays in git.

---

## ADR-019 — Benchmarks report a Pareto frontier, not a single score

**Status:** accepted (2026-10-29, Phase 4b)
**Context:** Comparing configurations on one blended number hides the trade-off that actually matters:
quality versus cost. A cheap configuration that passes 70% may be the right choice for low-risk work,
while a 95% configuration at 4× the cost may be right for production. Collapsing that into a winner
invites overfitting to the benchmark's task set and hides uncertainty (small sample sizes).
**Options:** one weighted score + ranking · pass rate only · pass rate and cost as a two-axis Pareto
frontier with labels and a recommendation only on dominance.
**Decision:** each configuration reports `passRate`, `weightedScore`, `sampleSize`, `costUsd`, `errors`
and `uncalibrated`; results are rendered as a pass-rate-versus-cost scatter. Non-dominated
configurations form the **Pareto frontier**; labels `highest_performance`, `most_efficient` and
`lowest_cost` are assigned where applicable. A single recommendation is produced only when one
configuration dominates every other one on both axes (or when only one configuration has samples);
otherwise the API says `pareto_frontier` and the human chooses by the axis they care about. Errors and
skipped trials are always reported, and no configuration with zero samples gets a fabricated rate.
**Consequences:** the comparison is honest about trade-offs and small samples; the UI has to explain
three labels instead of one winner. The frontier is recomputed from the persisted trial/result rows, so
a re-run with more samples can move it without rewriting history.
