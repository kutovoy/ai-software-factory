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

---

## ADR-020 — Improvement authority is a definition field, not a runtime toggle

**Status:** accepted (2026-10-29, Phase 5a)
**Context:** The factory can measure itself (scores, calibration, benchmarks) but the authority to
apply a self-proposed change must be explicit, auditable and changeable per factory. A runtime toggle
stored only in the DB would let an operator widen the blast radius without a diff, and the factory's
own source/gates must never be edited by the loop. The reference product's "self-improvement" panel
implies a setting, but the definition is the source of truth (ADR-003).
**Options:** a DB setting per factory · a global constant · a manifest field changed through the
definition path.
**Decision:** `improvement.authority` (`propose_only` default, `auto_merge_on_benchmark`, `canary`) is
a `factory.yaml` field validated by the schema (canary requires `canaryPercent` 1–100 and
`rollbackThreshold`; unknown fields fail). Changing it computes a diff, requires an actor + reason +
`confirm: true`, and opens a PR against the definition repo — the console never writes the worktree
(ADR-012). The authority recorded on a proposal at creation governs how *that* proposal lands, so a
change takes effect for proposals created afterwards. Proposals are file-scoped to
`agents/*/agent.md`, `skills/*`, `routing.yaml`, `scorers/*`, `automations/*`; anything else is
rejected with `edit_out_of_scope` and recorded.
**Consequences:** every autonomy widening is a reviewable git change with provenance; no hidden
switch. Cost: changing authority is slower than a toggle (PR + merge), and the UI has to explain the
diff. Canary is accepted as a level; its rollout mechanics are ADR-021.

---

## ADR-021 — Canary routing uses a deterministic hash at work-item creation (Phase 5b)

**Status:** accepted, implemented (2026-10-29, Phase 5b)
**Context:** A canary must route a configured percentage of *new* work to a candidate version and
compare it with the stable version over an observation window, with automatic rollback on regression.
Random assignment would make runs irreproducible and could split one work item's stages across
versions; a shared mutable counter would drift under retries and replays.
**Options:** random assignment per stage · a database counter · a deterministic hash of the work-item
id at creation.
**Decision:** a work item is assigned to stable or candidate exactly once, at creation, by
`sha256(workItemId) % 100 < canaryPercent`; the assignment (`definition_version` +
`canary_rollout_id`) is persisted with the item so every stage of that item runs the same version.
Only one rollout per factory may be in flight (`pending` or `active`); a second start is refused with
`canary_active`. The candidate version is published by `CanaryWorkflow`: the composed definition is
materialised under `runs/canary/<rolloutId>/definition` (writable runs dir, ADR-012), committed on a
`canary/<rolloutId>` branch and opened as a draft PR on the definition repo; candidate items pin the
candidate commit and run from the materialised tree, stable items pin the current definition commit.
The observation window is a durable Temporal timer; metrics compare pass rate and incident
(error/cancelled run) rate per commit over the window. A regression beyond `rollbackThreshold` rolls
back automatically; otherwise the window ending promotes by merging the candidate PR. Manual promote
and rollback are synchronous in the read model (routing stops matching the active rollout at once) and
wake the workflow with a Signal. `canary.started`, `canary.promoted` and `canary.rolled_back` are
append-only, deduped events carrying the reason and the evidence snapshot; the previous version stays
recorded on the rollout for rollback.
**Consequences:** routing is reproducible and testable without randomness; a work item never straddles
versions. Cost: the assignment must be stored and honoured by every dispatch path, the candidate tree
must be materialised for every rollout, and promotion merges the definition repo but does not rewrite
the local checkout — the next checkout/deploy picks up the merged version. A rollout that cannot
publish is recorded `unavailable` and never routes work.

---

## ADR-022 — The merge queue owns merges; no stage writes the default branch

**Status:** accepted, implemented (2026-10-29, Phase 3b)
**Context:** Phase 3a let the `ship` stage merge a pull request as soon as its own checks were
green. A PR can be green alone and red in combination (semantic conflict), and concurrent
merges race each other. The proposal requires that agents never push to `main` and that
multiple PRs land safely, with bisect and revert.
**Options:** keep the stage-level merge + rely on branch protection · GitHub auto-merge ·
a queue owned by our orchestration.
**Decision:** when a factory's GitHub integration declares `mergeQueue` (or a work item is
created with `mergeQueue: true`), the `ship` stage opens the PR and **enqueues** it; nothing in
the loop merges. `MergeQueueWorkflow` is one durable workflow per factory
(`merge-queue-<factory>`, `USE_EXISTING` on a second start), so at most one batch is in flight
(a unique partial index enforces it in Postgres too). A batch takes the oldest `batchSize`
(2) queued PRs and runs as a **merge train**: each PR is squash-merged, then the merged stack
is gated at the new head against required checks. Green keeps the merge; red reverts *just
that merge* (one revert commit) and marks the PR `needs_human` with the failing checks; the
rest of the batch still lands. A stack that never reports within `MERGE_CHECKS_TIMEOUT_MS`
fails `checks_timeout` and the whole batch is reverted (nothing merges). A human revert runs
as a one-shot `MergeRevertWorkflow` in the worker (the forge lives there) and is audited with
actor + reason (`merge.reverted`). The queue idempotency key is the branch
(`factory/<workItemId>`), not the PR number, so a reset forge cannot dedupe a fresh PR against
a stale merged row.
**Consequences:** merging is slower (serialized, gated) but safe; agents cannot push to the
default branch, and every merge/revert/bisect is an append-only `merge_events` row. Cost: a
merged PR cannot be merged twice, which is why bisect is a merge train rather than
"revert the batch and re-merge" — a requeued PR would need a new PR. The loop's Phase-3a
behaviour stays the default for factories that do not opt in, so existing flows and tests are
unchanged.

---

## ADR-023 — Webhooks are untrusted input by default

**Status:** accepted, implemented (2026-10-29, Phase 3b)
**Context:** Work now enters the factory from GitHub events. A webhook endpoint is
internet-facing: anyone can POST, redeliver, spoof a sender or embed instructions in an issue
body that an agent might follow. The payload is data, never a command.
**Options:** trust the network (GitHub only) · verify a shared secret · a GitHub App with
per-installation verification.
**Decision:** `POST /webhooks/:provider` verifies `X-Hub-Signature-256` (HMAC-SHA256, constant
time) against the secret referenced by the integration (`webhookSecretRef`, resolved from the
environment at request time; values never stored or logged) **before parsing**. A missing or
mismatched signature is rejected with `invalid_signature` (401) and no work item is created;
the rejection is recorded. Bodies above `WEBHOOK_MAX_BYTES` are rejected with
`payload_too_large` (413) before parsing. `X-GitHub-Delivery` is the idempotency key: a
redelivery is acknowledged and ignored (`duplicate_delivery`). Bot senders (`type: Bot` or
`[bot]` logins) are skipped by default (`skip_bots: all`), and the skip is recorded. Repository,
event, label and branch filters decide whether work is created; a non-matching event is
recorded with its reason (`repo_not_configured`, `event_not_configured`, `label_mismatch`,
`branch_mismatch`, `action_not_configured`, `no_matching_filter`) and ignored. Payload text
reaches an agent only inside an `[UNTRUSTED WEBHOOK DATA …]` frame, and `sourceRef.untrusted`
is `true` on the work item. When several factories watch the same repository the lowest
factory name wins, deterministically.
**Consequences:** spoofed and replayed deliveries are cheap to reject and fully audited
(`webhook_deliveries`). Cost: every integration must reference a webhook secret, and the
console has to show a secret *name* plus `configured: true/false` rather than the value. A
GitHub App installation flow (short-lived tokens, per-installation signatures) can replace the
PAT/secret pair behind the same interface.

---

## ADR-024 — Rebuild is replay, not repair

**Status:** accepted, implemented (2026-10-30, harden-runtime)
**Context:** Postgres is a projection of Temporal execution; the canonical per-run log is
`runs/<runId>/events.jsonl`. A drifted projection (a lost write, a restored database, a
schema experiment) had no recovery path short of deleting rows by hand.
**Options:** treat Postgres as the source of truth and back it up · regenerate rows from
Temporal history · replay the canonical JSONL log.
**Decision:** `factory rebuild --from runs/ [--dry-run]` reads every `events.jsonl`, validates
the sequence (it must start at 1 and be contiguous), and replays the logs in `(runId, seq)`
order. Runs, the boundary steps the workflow always writes (`persist-run`, `finish-run`) and
events are upserted idempotently; a second run reports no changes. Divergent rows are
overwritten from the log (the log wins) and reported. Rows that exist in Postgres but not in
the log are reported as `orphaned` and **never deleted** — a run whose directory was removed
is not silently resurrected or erased. A gap or duplicate `seq` fails the whole rebuild with
`event_log_corrupt` naming the run and sequence before any write. `--dry-run` reports the same
diff and writes nothing. The log does not carry the run's factory/definition commit (those
are API/Temporal inputs, not harness events): a run row that must be inserted inherits them
from the linked work item when the id encodes one, otherwise records `unknown` rather than
inventing a value.
**Consequences:** recovery is a command, and the diff is auditable. Cost: coarse steps other
than the two boundaries are not reconstructable from the log and stay reported as orphaned;
the rebuild does not repair Temporal history, only the read model.

---

## ADR-025 — sandbox-exec is an opt-in jail for the local runner

**Status:** accepted, implemented (2026-10-30, harden-runtime)
**Context:** the `local-process` runner executes the harness on the host with only env
filtering; the docker backend is the real isolation boundary, but cheap dev/CI runs use the
local one. macOS still ships `sandbox-exec`, which is deprecated but functional.
**Options:** leave the local backend unconfined · require Docker everywhere · generate an
SBPL profile for `sandbox-exec` behind a flag.
**Decision:** `RUNNER_SANDBOX=exec` makes the local backend run the harness (and its exec
commands) under a generated profile: `(deny default)`, reads allowed for system paths and the
workspace, writes allowed only to the workspace, the run directory and `/private/tmp`
(plus the `/dev` character devices), and `network*` denied unless the stage/factory grants
`networkPolicy: allowed`. A host without a sandbox backend (non-macOS, or no
`/usr/bin/sandbox-exec`) runs unconfined and records `runner.sandbox_unavailable` on the
runner step with the platform and reason. The default stays `none`, so existing behaviour is
unchanged.
**Consequences:** cheap runs can be confined without Docker; escapes fail at the OS level and
surface as tool errors, not crashed runs. Cost: sandbox-exec is deprecated (a replacement will
sit behind the same flag), the profile is macOS-only, and secrets still reach the process by
name — the sandbox is a filesystem/network boundary, not a credential boundary.

---

## ADR-026 — Secrets are names, never values

**Status:** accepted, implemented (2026-10-30, add-secrets-and-mcp)
**Context:** definitions already referenced secrets by name (ADR-011/ADR-023) but there was no
registry, no way to tell whether a referenced name resolves, and no audit of which runs used it. A
registry that stores values would become a second credential store with its own rotation, backup and
access story — exactly the surface the factory is trying to avoid.
**Options:** store encrypted values and return them masked · store metadata only and verify presence ·
keep names implicit in definitions with no registry.
**Decision:** `secrets` stores `{name, provider, scope, description, lastRotatedAt}` and nothing else.
A request carrying a `value` field is refused with `secret_value_rejected` *before* any query, and no
API projection ever includes a value (not even masked). Presence is checked through the env provider
at read time and reported as `resolved`/`unresolved`; a missing value registers fine and is surfaced,
not blocked. Usage is audited by **name**: the lease activity records the names a run resolved in
`run_secrets` (idempotent per `(runId, name)`) and increments `secret_usage` only for names that
actually resolved. Deleting a name still referenced by a definition is refused with `secret_in_use`
naming the resources — git stays the source of truth, so the guard reads definitions, not rows.
**Consequences:** no credential can leak from the registry because it never holds one, and rotation
is a metadata bump plus an out-of-band value change. Cost: the registry verifies *presence*, not
correctness — a typo in the value is only caught by the first real run (the UI says so), and a
managed secret provider (Vault/Supabase) needs a resolver behind the same `provider` field.

---

## ADR-027 — MCP permissions are per-agent globs

**Status:** accepted, implemented (2026-10-30, add-secrets-and-mcp)
**Context:** opencode supports MCP servers globally and per-agent tool globs; the factory needs
several agents with different tool surfaces, and a global "enable everything" default would give the
review agent the same write-capable tools as the implementer.
**Options:** enable every declared server for every agent · a separate permission file per harness ·
declare bindings on the agent and emit explicit allow/deny globs per agent.
**Decision:** a server is declared once on the factory (`mcp.servers`, transport + credential
*references*) and bound on the agent (`agents/<name>/agent.md` → `mcp: [server]`). The orchestrator
resolves the wiring from the definition the run is pinned to and hands the adapter only the bound
servers plus a permission map that states **both** sides: `"<server>*": "allow"` for each bound
server and `"<server>*": "deny"` for every declared-but-unlisted server. opencode merges agent
permissions over the global config, so the same globs are repeated on the agent override (the
explicit source of truth). An agent that declares no `mcp` gets no servers and an explicit deny for
every declared one — the resolved config says so rather than relying on a harness default. Harnesses
without MCP support receive the same wiring as canonical capability flags (`{supported: false, mode:
'recorded', servers, permissions}`), recorded on the session handle, never silently dropped.
Credentials reach the harness as `{env:NAME}` templates: the adapter payload contains names and globs
only, and a contract test asserts a value set in the environment never appears in it.
**Consequences:** the tool surface is declared in git and reviewable per agent, and an unbound agent
cannot reach a server by accident. Cost: globs are opencode-specific, so another harness only records
the intent (best effort) until it grows an equivalent; and adding a server is a two-file edit
(factory + agent) before it can be registered and tested.

---

## ADR-028 — Models are configuration references, resolved from the environment

**Status:** accepted, implemented (2026-10-30, fix-ui-audit-and-model-config)
**Context:** the example definitions hardcoded `openai/gpt-5`, a model that exists on one
vendor's account and not on the operator's LiteLLM proxy (which serves `best_llm`). A model
name is 12-factor configuration: baking it into a definition makes the definition portable
in schema but not in practice, and every operator has to edit git before the first run.
**Options:** hardcode the operator's model · add a per-provider model mapping file · allow an
environment reference on the existing `model` field.
**Decision:** `model` (and `harness.model`) accepts either a literal or `env:[A-Z_][A-Z0-9_]*`.
An invalid `env:` name is `invalid_value` at validation time. Resolution happens at load/run
time: the resolved config reports `{ref, value, source: literal|env}`, an unset variable is a
non-fatal warning (`model_env_unresolved`) so a fresh checkout still validates, and run
creation refuses an unresolved model with `model_unresolved` rather than sending the literal
`env:...` string upstream. The fake harness needs no model and falls back to
`fake/fake-model`. Example factories use `env:FACTORY_MODEL` (foreman/spec/implement),
`env:FACTORY_SMALL_MODEL` (triage/verify) and `env:FACTORY_REVIEW_MODEL` (review); `.env`
supplies the operator's values. The chat composer's default comes from the API's resolved
factory default, never a literal.
**Consequences:** the same definition runs against OpenAI, LiteLLM, or a local proxy by
changing environment, and the console shows the resolved value rather than the reference.
Cost: a run can fail late if the worker's environment differs from the API's (the refusal
names the variable), and benchmark suite configuration pins remain literals because a
benchmark compares named models.

---

## ADR-029 — Integration tests use a separate database

**Status:** accepted, implemented (2026-10-30, fix-ui-audit-and-model-config)
**Context:** the integration suites and the compose smoke/e2e flows shared the `factory`
database. Smoke/e2e rows, nightly schedule syncs and demo proposals accumulated in the same
tables the tests queried, so a test could observe another flow's residue and a failed run
could leave parked work items behind.
**Options:** truncate tables before every suite · give tests their own schema · give tests
their own database.
**Decision:** integration suites default to `factory_test`, created by
`scripts/postgres-init.sql` when the compose Postgres volume is first initialised (an
existing volume needs `create database factory_test owner factory` once). A Bun test preload
(`scripts/test-preload.ts`) supplies that default when `DATABASE_URL` is absent, so
`RUN_INTEGRATION=1` alone is enough; an explicit URL still wins. `scripts/smoke.sh` prints the
database it targets and, on exit, pauses the nightly schedule it synced and deletes the
throwaway secret it registered. `scripts/reset-dev.sh` removes smoke/e2e/demo rows from the
demo database and refuses without `--yes`.
**Consequences:** a test run cannot corrupt demo data, and a failed smoke leaves no nightly
schedule firing work items. Cost: a fresh dev volume needs the init SQL (or one manual
`create database`) before integration tests run, and reset-dev is a destructive command that
must stay explicit.

---

## ADR-030 — Path-versioned API with an OpenAPI document as the source of truth

**Status:** accepted, implemented (2026-10-31, add-api-v1-and-help-scope)
**Context:** the HTTP surface grew phase by phase with no version marker and no document. Every
resource (`/runs`, `/work-items`, `/secrets`, `/webhooks/*`, …) sat at the root, so an
incompatible change would silently break the console's server fetches, the smoke scripts and
the copy-paste examples in help and docs. Nothing inside the product described the API, and
nothing enforced that a new route was documented.
**Options:** header-based versioning (`Accept: application/vnd.factory.v2+json`) · a
`?version=` query parameter · a path prefix `/api/v1` · stay unversioned and rely on an
additive-only rule.
**Decision:** one **path prefix**. Every public resource lives under `/api/v1`, applied by a
single constant (`API_PREFIX` in `apps/web/src/lib/api.ts` and the equivalent on the API
side); `GET /health` stays unversioned for probes, and `GET /api/v1/health` serves the same
check to versioned clients. A breaking change — a removed/renamed field, an incompatible
response shape, a newly required parameter — bumps the prefix, and the old prefix keeps
serving until it is removed deliberately. Additive changes stay in `v1`.
`apps/api/openapi.json` (OpenAPI 3.1) is the **source of truth**: it is served at
`GET /api/v1/openapi.json`, and a contract test compares the registered route table with the
document, failing in both directions with method + path. The console renders `/help/api`
from that document (through the web client, so the prefix stays server-side) instead of a
second hand-written list, and links to it for Swagger UI/Postman. Browser-facing same-origin
route handlers stay under `/api/*`; `apiUrl()` applies `/api/v1` only when talking to the
backend, so the two prefixes cannot be confused.
**Consequences:** the version is visible, cacheable and directly consumable by standard
tooling, and the document cannot drift from the routes without a red test. Cost: a version
bump is mechanical but wide (every caller, smoke script and help example), a route change
must edit `openapi.json` in the same commit, and a browser-facing handler cannot live at
`/api/v1/...` without colliding with the backend convention.

---

## ADR-031 — Executable API explorer through a same-origin catch-all proxy

**Status:** accepted, implemented (2026-10-31, add-live-api-explorer)
**Context:** `/help/api` rendered the OpenAPI document but could not execute it. Swagger UI's
"Try it out" runs in the browser, and the document declares `http://localhost:8080` as its
server — a cross-origin call that the browser blocks. Two options were on the table: enable CORS
on the API, or keep every request on the console origin and proxy it server-side.
**Options:** permissive CORS on `apps/api` · a browser-side rewrite to `/api/v1/...` plus a
catch-all route handler · a separate explorer service.
**Decision:** a **catch-all same-origin proxy**. `apps/web/src/app/api/v1/[...path]/route.ts`
forwards every method to `${API_BASE_URL}/api/v1/<path>` with query, body and headers, returns
status/content-type/body unchanged, streams the response (SSE stays incremental) and drops
hop-by-hop headers in both directions. Swagger UI itself is client-only
(`dynamic(..., { ssr: false })`) and rewrites the spec's absolute server URL to the console
origin through `requestInterceptor`; the server-rendered reference stays below as the no-JS
fallback. Because `swagger-ui-react`'s native `tree-sitter` transitive dependencies cannot build
in `oven/bun` (no Python, no libstdc++ for the prebuilds), the root `package.json` sets
`"trustedDependencies": []` so install-time lifecycle scripts are blocked — nothing in the repo
needs them, and the explorer uses Swagger UI's prebuilt browser bundle.
**Consequences:** no CORS surface on the API, one origin for the browser, and the explorer
executes exactly what the served document declares. Cost: the proxy accepts every method and
path under `/api/v1`, so it must stay a transparent forwarder (no console-side auth or
filtering), and a new backend route is reachable through the console the moment it is served.
Blocking dependency scripts means a future package that genuinely needs a postinstall must be
added to `trustedDependencies` deliberately.

---

## ADR-032 — The factory owns a local forge; identity is asserted by the console proxy

**Status:** accepted, implemented (2026-11-01, add-forgejo)
**Context:** Every factory PR was recorded against the fake backend, so links pointed at
`https://forge.local/...` and resolved nowhere. The factory needs a repository backend the
operator can actually open, and the identity design must not paint itself into a corner for
multi-user (Phase 6). The console has no auth yet, so any identity story is local/single-user
until then.
**Options:** keep the fake backend and rewrite links · point at public GitHub (needs an App,
internet, credentials) · run a self-hosted forge and serve it from the console origin · run a
separate reverse proxy in front of the forge.
**Decision:** a **Forgejo** service (pinned `codeberg.org/forgejo/forgejo:17.0.1`) owns the
forge, enabled by default, with its own database and volume. It is hosted on a **subpath**:
`ROOT_URL=http://localhost:3000/extras/forgejo/` and `STATIC_URL_PREFIX=/extras/forgejo`, so
every link and asset it generates stays on the console origin. The console serves that prefix
from a catch-all route handler (`apps/web/src/app/extras/forgejo/[[...path]]/route.ts`) that
strips the prefix, streams the request/response (git-over-HTTP included) and injects the
trusted `X-WebAuth-User` header; Forgejo runs `ENABLE_REVERSE_PROXY_AUTHENTICATION` with
`REVERSE_PROXY_AUTHENTICATION_USER=X-WebAuth-User`. A plain Next rewrite cannot add a request
header, which is why the proxy is a handler rather than a rewrite. The forge has **no
published host port**: it is reachable only from the compose network, so the header cannot be
spoofed from a browser (`REVERSE_PROXY_TRUSTED_PROXIES=*` is acceptable only because of that).
This is explicitly **single-user local mode**: the console asserts the seeded admin for every
request and says so in Settings and Help. **Multi-user (documented, not built):** Phase 6
console auth makes the proxy assert the signed-in user, and Forgejo OIDC group mappings place
each user in a per-user organization/team so users only see their own projects. Keycloak is
one option, not a requirement — Forgejo is itself an OAuth2 provider and any OIDC IdP fits.
The `CodeForge` GitHub client speaks the **Gitea-compatible dialect** when
`GITHUB_API_BASE_URL` is not `api.github.com`, behind the same contract: refs are read from
`git/refs`, branches are created with `POST /branches`, commits are written through the
contents API (Gitea has no write blob/tree/commit endpoints), checks come from commit
statuses (an empty status set is green — a forge with no CI has nothing red), merges use
`POST .../merge` with `Do`, and revert restores the target tree file by file. Which backend a
factory uses is decided by its stored integration: enabled + not a dry run + a secret that
resolves ⇒ the real forge; anything else ⇒ the fake backend, so smoke and CI stay
credential-free (`CODE_FORGE` overrides both).
**Consequences:** PR URLs resolve from the operator's laptop and `git clone
http://localhost:3000/extras/forgejo/<org>/<repo>.git` works through the console. SSH and
websockets are out of scope in v1. Cost: the proxy is a security-relevant hop (it must keep
asserting the header and must never forward a browser-supplied one), git pushes travel through
Next (a dedicated proxy can replace it later without changing URLs), and the Gitea dialect
needs maintenance as Forgejo's API drifts — the shared contract suite plus a live check
against a real instance are the guard.

## ADR-033 — MIT license with an attribution request; README is the public front door

**Status:** accepted (2026-11-01). **Context:** the project is being published publicly on
GitHub. MIT requires preserving the copyright and license notice; it does not require a
credit beyond that. The author wants a visible reference back to the original creator without
making the license non-standard or legally ambiguous.
**Decision:** ship the standard MIT text in `LICENSE` with `Copyright (c) 2026 Nick Kutovyy`,
and add a `NOTICE` that *requests* attribution ("credit Nick Kutovyy" on use, fork or
redistribution) while stating explicitly that it is not an additional license condition.
`README.md` follows the structure of a mature open-source project (header, links, badges,
introduction, features, getting started, security, contributing, creator, license) and keeps
a Creator/attribution section. `AGENTS.md` requires README updates in the same change as any
feature or install change. `SECURITY.md`, `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` are part
of the public surface.
**Consequences:** the license stays MIT-compatible and GitHub-detectable; attribution is a
social request rather than a restriction, so downstream use remains unencumbered. The README
becomes a maintained artifact, not a one-off.

## ADR-034 — Forge transport: SSH on the default stack, websockets as an opt-in proxy mode

**Status:** accepted, implemented (2026-11-01, polish-forge-and-public)
**Context:** ADR-032 shipped the forge behind the console's same-origin proxy: HTTP works, but
git over SSH is impossible through a route handler and websocket upgrades cannot be performed
by one either. Operators pushing real branches want `git push` over SSH, and Forgejo's live UI
uses websockets.
**Options:** keep HTTP-only · add SSH to the default stack and websockets behind an optional
proxy · make the proxy the only mode (single origin on :3001) · run a proxy in front of
everything.
**Decision:** SSH is **additive on the default stack**: Forgejo's built-in SSH server runs on
`:22` inside the container, published as `2222:22`, with `SSH_PORT=2222`, `SSH_DOMAIN=localhost`
so clone URLs are `ssh://git@localhost:2222/<org>/<repo>.git`. Host keys persist under
`/data/gitea/ssh` in `forgejo-data`. The image also ships an OpenSSH daemon as an s6 service on
`:22`, which collides with the built-in server, so that service directory is masked with a
`tmpfs` mount — one SSH server, one owner of the port. Keys are not seeded: the operator adds
one in Forgejo → Settings → SSH keys. Websockets are an **opt-in mode**: `compose.proxy.yaml`
adds Caddy on `:3001`, points `ROOT_URL` at `http://localhost:3001/` with an empty
`STATIC_URL_PREFIX`, and reverse-proxies everything (upgrades included). Auth is preserved by a
new `GET /api/v1/auth/forge-identity` route: a signed-in session answers `200` with
`X-WebAuth-User` (401 otherwise), and Caddy's `forward_auth` copies that header onto the
proxied request, so the forge keeps auto-login and the browser still cannot spoof the header.
The default single-origin setup (`:3000`, `/extras/forgejo`) is unchanged.
**Consequences:** `git clone`/`push` work over SSH without touching the console proxy, and
websockets are available where they matter without making a proxy mandatory. Costs: the host
publishes a port (SSH authenticates by key, not by the trusted header, so the spoofing argument
of ADR-032 still holds), the `tmpfs` mask is an image-specific workaround that must be revisited
if Forgejo changes its s6 layout, and in proxy mode the forge's own links leave the
`/extras/forgejo` subpath, so the console subpath proxy is not the primary path there
(documented in README/HANDOVER/help).

## ADR-035 — Console auth: hashed opaque sessions, env bootstrap, per-user scope

**Status:** accepted (2026-11-01). **Context:** the console and API were unauthenticated, the
Users page was a stub, and the forge proxy asserted one seeded admin for every visitor.
**Decision:** add `users` + `sessions` (migration 016). Passwords are argon2id via
`Bun.password`; sessions are 32-byte opaque tokens stored only as SHA-256 hashes, carried in
an HttpOnly `SameSite=Lax` cookie with a 7-day sliding expiry. `AUTH_REQUIRED` is the single
switch (off for unit/integration tests and local dev, on in compose); public routes are
`/health`, `/auth/login`, `/openapi.json`. The first admin is bootstrapped from
`FACTORY_ADMIN_EMAIL`/`FACTORY_ADMIN_PASSWORD` (random one-time password if unset); compose
ships documented local-development credentials. Roles are `admin` (all work, user management)
and `member` (only rows they created). Work items and chat runs carry `created_by`; stage runs
inherit their item's owner. The console forwards the session cookie server-side and copies
`Set-Cookie` through its proxy. The Forgejo proxy resolves `/auth/me` and asserts the user's
username; a best-effort personal org `u-<username>` is created on login.
**Consequences:** a database leak does not yield live sessions; auth-off keeps the old
single-user behaviour. OIDC/IdP and group→org mappings are deferred to Phase 6c (the
`FORGEJO_OIDC_GROUP_MAP` contract is reserved), and compose credentials must be rotated before
exposing the console.

## ADR-036 — Agent verdicts: JSON first, textual fallback, policy per factory

**Status:** accepted (2026-11-01). **Context:** agent gates approved whenever a stage run ended
`ok`; a reviewer that wrote “FAIL” still passed, which is unsafe for lights-off.
**Decision:** agent-gated stage prompts ask for a final fenced JSON block
`{"verdict":"approve|request_changes|reject","summary":…,"findings":[…]}`. The parser takes
the last structured block, accepts explicit textual signals (`VERDICT: FAIL`, a `FAIL` line,
`REQUEST_CHANGES`) as a fallback, and reports `structured | textual | none`. The factory field
`agentVerdict` is `advisory` (default: unknown → approve, preserving old behaviour) or
`required` (unknown → request_changes). `request_changes` feeds the existing loop/escalation
path; `reject` rejects. The parsed verdict (`decision`, `source`, `summary`, `findings`) is
stored on `gate_decisions.verdict` and surfaced in the inbox/API.
**Consequences:** a lights-off factory can make reviewer agents authoritative without a human,
while existing factories keep working until they opt in. A textual FAIL can no longer be
silently ignored.

## ADR-037 — Factory identity: committed `fac_` id, owner-scoped path, nested URLs

**Status:** accepted (2026-11-02). **Context:** factory identity was the global directory name; every URL was
`/factories/<name>/…`, the API was name-based, and two users could not own the same factory name. A member who
guessed a name could reach another user's factory pages unless every route was owner-checked.
**Decision:** each definition carries a committed `id: fac_<ulid>`. A `factories` registry maps id → owner, name,
key, path and alias. New factories live at `factories/<owner>/<name>`; legacy top-level directories stay in place
as admin-owned for compatibility. The internal DB `factory` text is the unique key (`owner/name` or legacy name);
work items and runs also carry `factory_id`. All factory resources are addressed by the opaque id:
`/factories/<id>/…` and `/api/v1/factories/:factoryId/…`, with work items and runs nested under the factory. The
old name/global routes are removed (no aliases or redirects). Members resolve only factories they own; admins
resolve all; anything else is 404. New factories default `repositories.owner` to `u-<owner>`; legacy factories keep
their declared owner.
**Consequences:** factory names can repeat per user, URLs are unguessable, renames do not break links, and a
database rebuild can recover ids from git. Costs: a breaking `/api/v1` shape (ADR-038), a registry/backfill
migration, and the CLI/console/OpenAPI/smoke/E2E all move together.

## ADR-038 — Factory purge v2; breaking nested API stays under `/api/v1`

**Status:** accepted (2026-11-02). **Context:** `delete-factory` silently skipped the DB purge when
`DATABASE_URL` was unset, paused Temporal schedules without deleting them, never terminated workflows and left
run directories; a reused factory name then showed old data.
**Decision:** purge is an API operation (`DELETE /api/v1/factories/:factoryId`, owner/admin). It fails closed if
DB/Temporal are unavailable, refuses active work unless forced, deletes all factory-scoped rows in one verified
transaction, deletes Temporal schedules, terminates running workflows and removes `runs/<id>/`. Git history and
the forge repository/PRs are kept by default. The CLI authenticates, resolves the id and calls the endpoint. The
nested-only API shape is a deliberate exception to the ADR-030 prefix-bump rule: it ships under `/api/v1` with
all clients updated in the same change, rather than maintaining a second version.
**Consequences:** deletion cannot silently leave rows behind; closed Temporal histories remain until retention;
the API break is recorded here and must be called out in release notes.

## ADR-039 — One factory path for every factory-scoped resource

**Status:** accepted (2026-11-02). **Context:** after the factory identity change, most resources were nested under
`/api/v1/factories/:factoryId/…`, but scores, calibration, scoring, benchmark/improvement detail, proposals,
lessons and webhook deliveries still used global paths with `?factory=`. The console also had global
`/scores/[id]` and `/mcps` pages.
**Decision:** every factory-scoped API resource is addressed through `/api/v1/factories/:factoryId/…`; no
factory query parameter remains. Work-item/run creation takes the factory from the path. Browser factory-scoped
pages live at `/factories/<id>/…`; only `/factories` (list), `/inbox` (cross-factory queue), `/chat`, `/secrets`,
`/users` and `/help` stay global. The shape is rewritten in place in `/api/v1` (a second explicit exception to the
ADR-030 prefix-bump rule), with all clients updated in the same change. No DB migration is needed.
**Consequences:** one predictable path shape, no factory query leakage in logs/links, and nested browser parity.
Cost: another breaking v1 rewrite; release notes must call it out and all API clients/smoke/E2E move together.

## ADR-040 — Forge PRs contain applied files, not patch artifacts

**Status:** accepted (2026-11-02). **Context:** `forgeOpenPullRequest` committed a single
`changes/<workItemId>.patch` file containing the implement diff instead of applying it. Forgejo PRs therefore
showed only that patch file (plus seeded README/probe files), while QA passed because it tested the runner
workspace, not the PR branch.
**Decision:** opening a factory PR checks out the new branch, applies `patch.diff` to a temporary copy of the base
snapshot with `git apply`, and commits the resulting add/modify/delete `FileChange[]`. A missing or empty patch
fails with `patch_missing`; an unapplicable patch fails with `patch_apply_failed`; binary patches are rejected
because the forge file API is text-only. The `.patch` artifact is never committed. The Forgejo bootstrap resolves
the factory id and posts the integration to `/api/v1/factories/:factoryId/integrations/github`.
**Consequences:** PRs and the default branch contain the real web code, and a PR cannot silently degrade into a
patch-only artifact. QA remains workspace-based, but a dedicated integration test asserts the PR branch files.

## ADR-041 — Validation contracts are persisted work-item artifacts

**Status:** accepted (2026-11-03). **Context:** a work item had free-text scope and a Playwright QA run, but no
machine-checkable definition of what “verified” meant. A QA agent could report success without covering the
acceptance criterion, and a human could approve a verify gate with no evidence.
**Decision:** a work item receives a deterministic validation contract at creation, persisted in
`work_items.input.validationContract`. The contract carries `id`, `title`, `tier`, `required`, `evidence` and an
optional command per check; tiers are `unit`, `component`, `integration`, `e2e` and `manual`. Checks come from the
factory's optional `validation` block or are inferred from repository scripts; a manual acceptance check is always
added. The verify stage receives a fenced-JSON evidence instruction; agent evidence and forge check results are
projected into `pass | fail | missing`. When `validation.enforce` is true, a verify gate cannot approve while a
required check is missing: a human approval is refused with `validation_incomplete`, an agent gate becomes
`request_changes`. Enforcement defaults to off so existing factories keep their current loop.
**Consequences:** “verified” becomes an explicit contract rather than a prose claim; QA can cover the QA pyramid
without a new agent; factories opt into stricter gates. The contract is additive to the work-item read model and
does not require a DB migration.

## ADR-042 — Readiness is deterministic, advisory by default, opt-in as an autonomy gate

**Status:** accepted (2026-11-03). **Context:** autonomy could be enabled without evidence that the repository or
the factory definition was ready for unattended work. A model-based readiness judgement would be another
non-deterministic gate on top of the benchmark attestation.
**Decision:** `scanReadiness` computes a 0–100 score from observable files and definition fields only: repository
style, build, tests, typecheck, docs, dev environment, observability, security and task discovery; factory QA
agent, two reviewers, gates, merge policy, required verdicts, scorers/benchmarks, secrets and MCP. Status is
`ready` ≥ threshold (default 80), `warn` ≥ threshold (default 60), otherwise `not_ready`. Every check carries
evidence and a remediation hint. Readiness is advisory by default; `readiness.enforceAutonomy: true` refuses
autonomy below `ready` with `readiness_not_ready` unless an explicit `{actor, reason}` override is recorded.
**Consequences:** readiness is inspectable and reproducible, not a model opinion. The scan targets the local
checkout (`REPO_ROOT`); a target-repo checkout is a later runner/forge concern, and the report names the root it
scanned so the mismatch is visible.

## ADR-043 — Guard hooks are pure, fail-closed pre-PR checks

**Status:** accepted (2026-11-03). **Context:** agents could prepare a PR containing a protected-branch write, a
path escape, a secret or an oversized change; the forge rejected some of these, but only after a commit/branch
existed, and the failure was not recorded as a factory decision.
**Decision:** `runGuardHooks` runs in `forgeOpenPullRequest` after the patch is applied and before the commit. It
is a pure function over the branch, applied files and the factory's optional `guard` block: protected branch,
path containment (absolute paths, `..`, `.git/`), narrow secret patterns, changed-file and patch-byte limits, and
a binary-file limit. A failure is non-retryable (`guard_failed`) and records `guard.failed`; a pass records
`guard.checked`. No shell command, network call or filesystem write is performed by a hook. The resolved config
and recent results are exposed at `GET /api/v1/factories/{factoryId}/guard-hooks`.
**Consequences:** obvious unsafe PRs fail before a branch is written and leave an audit event; the hooks cannot
execute arbitrary policy code. Secret patterns are deliberately narrow to avoid false positives; a factory can
disable the scan explicitly.

## ADR-044 — Runner cleanup is guaranteed and reconciled by a label-based reaper

**Status:** accepted (2026-11-04). **Context:** 29 detached `factory-runner-*` containers leaked because
`RunWorkflow` awaited `readTerminalState` outside its non-cancellable cleanup scope. A cancellation delivered there
skipped `finishRunActivity` and `killRunner`; lease-time cancellation and worker kills could also leave containers,
and nothing reconciled Docker against the run read model.
**Decision:** all post-run cleanup runs in one `CancellationScope.nonCancellable`, with `killRunner` last and
best-effort. `leaseRunner` heartbeats so cancellation can be observed while Docker is leasing; `killRunner` can
derive the deterministic container name when no lease handle exists. The worker periodically runs a label-based
reaper over `factory.runner`/`factory.run` containers: it removes containers for terminal or missing runs, closed
or missing workflows (after a grace period), and old containers; it marks orphaned `running` runs `error` with
`runner_orphaned`. If Temporal is unreachable, live-looking containers are skipped. `bun run reap:runners` exposes
the same logic with a dry-run default and `--apply`.
**Consequences:** a cancellation or worker crash cannot silently leave a sandbox forever. The reaper is conservative
and DB/Temporal-aware rather than a blanket `docker system prune`; a stale `running` row may briefly exist until the
next reaper pass, and its terminal error is explicit.

## ADR-045 — Roadmap items 6–11: trace scores, routing/budgets, intake, context, governance, surfaces

**Status:** accepted (2026-11-04). **Context:** the factory had scoring, benchmarks, self-improvement,
canary, merge queue, MCP wiring and auth, but no trace-level scoring, runtime routing, spend caps, external
intake, capability discovery, per-action governance or CLI/CI surface.
**Decision:** implement each as a separate OpenSpec change:
(6) deterministic trace evidence + four trace checks feed the existing scorer/proposal path;
(7) an opt-in deterministic `routing.classifier` (cheap/standard/deep) and hard per-run/stage/factory
budgets enforced in the event pump and at creation;
(8) one nested intake endpoint with provider adapters, HMAC verification, delivery dedupe and untrusted
framing;
(9) an opt-in `mcp.discovery` selector plus a persisted `mcp_tools` capability index with discover/promote;
(10) an optional `governance` block (autonomy level, model allowlist, deny/human-required actions) with
`policy` audit steps; SSO/OIDC stays out of scope;
(11) CLI `run`/`intake` surfaces that call the same API/runner path as the console, with Slack/CI reusing
intake.
**Consequences:** the factory can be tuned, capped and audited without adding a second execution path.
Keyword routing/context selection is intentionally explainable and replaceable; budgets are guardrails, not
sandboxes; OIDC/IdP, remote runners, Temporal Cloud and multi-tenant isolation remain Phase 6c blockers.

## ADR-046 — Remote runner control plane + host observability

**Status:** accepted (2026-11-04, Linux MVP implemented on `feat/remote-runners`; Windows/macOS and
mTLS certificate issuance are follow-ups).
**Context:** local Docker runners work, but remote hosts need UI-driven enrollment, platform-specific
sandboxes and host health visibility. GPUSTACK’s Add Worker flow is the reference: preflight command,
generated install command, agent registration/heartbeat, and local workload spawning.
**Decision:**
- Use a GPUSTACK-style **runner host agent** enrolled from the console: preflight → generated install
  command → agent registers over outbound TLS. One-time enrollment token exchanged for a hashed bearer
  agent token; no long-lived token in the command line. mTLS certificate fingerprinting is reserved for
  hardening.
- Keep **central Temporal** as the durable scheduler. Remote hosts get **no Temporal or Postgres
  access**; the agent is an executor over an agent-initiated control stream.
- Central scheduler selects hosts by platform, pool, labels, tenant and capacity; no match is
  `no_matching_runner`.
- Platform order: Linux Docker first; Windows native process (MSBuild/dotnet) with optional Windows
  containers; macOS native Xcode process with optional Tart VM.
- Host observability is part of the workstream: CPU, RAM, disk/inodes, load, heartbeat, leases; alerts
  with configurable thresholds, dedupe, acknowledge/silence, console inbox + webhook.
- Implementation branch: `feat/remote-runners`; OpenSpec change `add-remote-runners` covers the
  Linux control plane and host observability. The agent runs the harness adapter locally and streams
  canonical events back to the central writer; the MVP uses a bearer agent token behind TLS, with mTLS
  certificate fingerprinting reserved for hardening. Only `patch.diff` content is transferred back;
  other artifact blobs remain on the remote host until object storage is wired.
**Consequences:** the current security model stays intact (secrets and provider keys central, no DB on
remote hosts), but the runner protocol becomes a network protocol with mTLS, lease TTLs and resumable
event streams. Windows/macOS native runners are weaker isolation than Linux containers and need
dedicated hosts/VMs for untrusted code. Plan: `docs/REMOTE_RUNNERS_PLAN.md`.
