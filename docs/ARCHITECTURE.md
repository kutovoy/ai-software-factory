# Architecture

Status: draft v0.1 (2026-10-28; remote-runner live verification 2026-11-05; retention/quotas/promotion
2026-11-06). Grounded in `research/warp-factories.md`, `research/ecosystem.md`,
`research/videos/x-PK3yx_MJg/ANALYSIS.md`.

## 1. Shape

```
┌──────────────────────────── apps/web (Next.js) ────────────────────────────┐
│ Chat (harness front-end) · Inbox · Runs · MCPs & apps · Secrets · Users     │
│ Factories ▸ Dashboard · Agents · Automations · Scorers · Self-improvement   │
│             Benchmarks · Definition · Gates · Settings                      │
└───────────────▲──────────────────────────────────────────▲─────────────────┘
                │ REST + SSE (FactoryEvent stream)          │ tRPC/REST
┌───────────────┴──────────── apps/api ────────────────────┴─────────────────┐
│ Sessions · Runs · WorkItems · Gates · Approvals · Definitions · Benchmarks  │
│ Orchestrator (workflow per work item) ──▶ durable waits, timers, retries    │
└───────┬───────────────────────┬───────────────────────┬────────────────────┘
        │                       │                       │
  packages/core           packages/adapters        packages/evals
  schema+domain+db        HarnessAdapter iface      scorers, benchmarks,
  (definitions in git)    opencode│cli│acp          self-improvement loop
        │                       │
        │               packages/runners
        │               lease → exec → heartbeat → artifacts → kill
        ▼                       ▼
   Postgres (index)      local Docker runner  /  remote worker (later)
```

**Hard rules**
- Definitions live in git; the DB is an index/cache. Every run pins `definitionCommit`.
- Tool execution never happens in `apps/web` or `apps/api` — only in runners.
- The chat *is* the harness front-end: it consumes the same `FactoryEvent` stream the runner produces.
- Models are reached only via an OpenAI-compatible base URL (`OPENAI_BASE_URL`, key from secrets store).
- Harnesses are reached only through `HarnessAdapter`. No vendor calls from UI/domain code.

## 2. Factory definition (the source of truth)

Path-is-identity, Markdown frontmatter + prose body (Warp's shape, ours extended):

```
factory.yaml
agents/<name>/agent.md          # frontmatter: role, model|harness, runner, tools, gates
automations/<name>/automation.md
scorers/<name>/scorer.md        # labels[{value,score}], passingScore, samplingRate, judge model
benchmarks/<suite>/suite.yaml   + tasks/<task>.yaml
skills/<skill>/SKILL.md
runners/<name>.yaml
routing.yaml                    # stage → model/harness rules (collapses Warp's routers/)
packs.lock                      # pinned imports of shared packs (Gas City idea)
```

`factory.yaml` (ours, v1alpha1-compatible but extended):

```yaml
schemaVersion: v1alpha1
name: acme-core
alias: Core
repositories: [{owner: acme, name: api-service}]
agentDefaults:
  harness: {type: opencode, model: ${FACTORY_MODEL}}   # or model: <id>; mutually exclusive
  runner: local-docker
gates:                       # NEW: the lights-on/off dial
  spec: human
  plan: human
  implement: agent
  review: agent
  pr_review: human
  deploy: human
mergePolicy: auto_on_green  # human | auto_on_green | auto_after_n_approvals | disabled
selfImprovement:
  enabled: true
  failedRunThreshold: 3
  reviewerType: humans      # humans | none (lights-off)
  requireBenchmarkWin: true
integrations: [github, slack]
```

Gate resolution order: `automation override → factory.gates → global default`.
Each gate is `human | agent | policy:<name>`. "Lights off" = all gates `agent` + `mergePolicy: auto_on_green`
+ a global kill switch that flips everything back to `human`.

**Versioning:** a factory version = a git tag (`factory-vN`) + commit SHA of the definition repo.
Every run, score and benchmark records `definitionCommit`. The UI has a *Definition* page with diff,
history, clone, and "compare versions" (benchmark two commits side by side). This is the feature Warp
does not have.

## 3. Harness adapters

```ts
interface HarnessAdapter {
  id: "opencode" | "claude-code" | "codex" | "gemini" | "generic-cli";
  capabilities: { streaming, toolCalls, permissions, resume, fork, usage, structuredOutput };
  startSession(req): Promise<SessionHandle>;
  sendPrompt(h, parts, opts?): Promise<void>;
  streamEvents(h, signal?): AsyncIterable<FactoryEvent>;
  cancel(h, reason?): Promise<void>;
  resume(h, ref?): Promise<SessionHandle>;
  fork?(h, atMessageId?): Promise<SessionHandle>;
  respondToPermission(h, requestId, decision): Promise<void>;
  listAgents(h): Promise<AgentDescriptor[]>;
  getDiff(h): Promise<FileDiff[]>;
  getUsage(h): Promise<UsageReport>;
  dispose(h): Promise<void>;
}
```

`FactoryEvent` = AG-UI-shaped union: `run.started | message.delta | message.completed |
tool.call.started/args.delta/completed | permission.requested | file.edited | artifact.produced |
usage.updated | run.completed`.

Build order: canonical union → **opencode** (native HTTP+SSE against `opencode serve`) → **generic-cli**
(JSONL stdout) → **ACP** (unlocks Gemini and others) → Claude Code / Codex JSONL.

Because the UI is the harness front-end, the adapter is also what powers *New Chat*: a session is just a
run with a human-initiated prompt, and the same stream renders both chat and factory runs.

## 4. Runners

Protocol (one implementation, two backends):

```
lease(runnerSpec) → {runnerId, workspace}     # git worktree/checkout at pinned SHA
exec(runnerId, cmd | toolCall) → stream        # stdout/stderr/exit
put/get artifacts                              # patches, logs, screenshots, videos
heartbeat(runnerId)                            # liveness, resource usage
kill(runnerId)                                 # idempotent
```

- `local-docker`: container per run, bind-mounted worktree, no host network by default.
- `local-process` (fallback): git worktree + `sandbox-exec` (macOS) for cheap runs.
- `remote-runner` (Linux/Windows/macOS): a UI-enrolled host agent polls an outbound command queue, runs
  the sandbox and harness adapter locally and streams canonical events back to the central worker. Central
  Temporal schedules; the host gets no Temporal/Postgres credentials. Host CPU/RAM/disk metrics and
  alerts are stored centrally. Artifacts upload directly to RustFS via short-lived presigned grants;
  `S3_ENDPOINT` is the agent upload URL and `S3_PUBLIC_ENDPOINT` is the browser download URL.
  macOS M5 native (`sandbox-exec`) and Linux Docker agents were live-verified on 2026-11-05. The agent
  uses a bearer agent token behind TLS; mTLS fingerprinting, Windows live verification, Windows
  containers, macOS Tart and service-manager wrappers are follow-ups. See
  `docs/REMOTE_RUNNERS_PLAN.md`, `openspec/specs/remote-runners/spec.md`,
  `openspec/specs/artifact-store/spec.md` and
  `openspec/changes/archive/2026-11-04-add-remote-runners`.

Secrets are resolved **outside** the sandbox and injected as env only for the tools that need them;
inference credentials never enter the runner (Warp's four-boundary model).

## 5. Orchestration

**Temporal from day one** (ADR-001). `temporal server start-dev` locally + one Bun worker.

- `RunWorkflow` — one per chat message / ad-hoc run (Phase 2).
- `FactoryWorkflow` — one per work item (Phase 3); child workflows per stage.
- Activities wrap runner RPC and model calls; all Activities idempotent, retried with backoff.
- Gates are Temporal **Updates** (synchronous decision) + **Signals** (async steer); `awaitGate` is a
  durable wait with an escalation timer — days-long waits cost nothing. **Permission requests use the
  same shape (ADR-013): `pumpEvents` returns at `permission.requested`, the workflow waits on
  `condition()` for the Update/Signal, and the run resumes from the last `seq`. A blocked run holds
  no activity slot, so blocked runs cannot starve the queue.**
- Temporal event history is the execution truth; we mirror a canonical `FactoryEvent` JSONL + Postgres
  read model for the UI (SSE fan-out). Temporal visibility gives per-run search and replay.

Rejected: Inngest (per-step cost, wrong step shape), Windmill (not an orchestrator for this).
Fallback if Temporal ops become painful: Restate (single binary, virtual objects per session).

## 5a. Data lifecycle, quotas and promotion

Run evidence is bounded: the worker sweeps terminal runs older than `RETENTION_DAYS` beyond the newest
`RETENTION_KEEP_RUNS` per factory, deleting their DB rows, `runs/<id>/` directories, RustFS artifact blobs
and terminal canary trees. Pending/running runs are protected, and the manual `POST /runs/gc` route uses the
same core with `dryRun`. Factories can cap lifetime, daily and monthly spend plus concurrent runs; admission
refuses new work with `factory_budget_exhausted` or `factory_quota_exhausted`, and `GET /budget` projects live
usage. A promoted canary merges the forge PR, rewrites the local definition checkout when the git worktree is
clean, and commits it; a dirty or non-git checkout records `promotion_pending_deploy` instead of overwriting
operator work. See ADR-049 and `openspec/specs/{retention,quotas,self-improvement}`.

## 6. Measurement and self-improvement

```
factory agents ──▶ runs ──▶ event log ──▶ scorers ──▶ scored runs
                                                    │
                              benchmarks (replay at pinned SHA) ──▶ compare versions/configs
                                                    │
                                    self-improvement agents ──▶ PR against definition repo
                                                    │
                                   human merge  OR  benchmark gate (lights-off)
```

- **Scorers**: classification + `passingScore` + `samplingRate`, judge model recorded with version +
  prompt hash so scores stay comparable; deterministic checks (tests, lint, build) run first and are free.
- **Judge calibration**: maintain a golden set and report judge-vs-human agreement; block self-improvement
  if agreement drops below threshold. (Gap identified in the video analysis.)
- **Benchmarks**: task sets pin `startingRepoRefs` to full SHAs **and** `definitionCommit`; replay runs in
  hermetic sandboxes with recorded tool responses; output = correctness-vs-cost Pareto matrix.
- **Self-improvement (Harness²-inspired)**: observer agents read scored runs → propose invariant (general)
  and domain (repo-specific) edits → probe on the same work item → compose winners → open a PR. Lessons
  go into an experience library (`INDEX.md` + `EXPERIENCE.md`: cue / lesson / evidence / confidence).
  Never auto-applies without a benchmark non-regression gate.
- **Dedupe**: cluster proposals by root cause and rank by impact (failed runs × cost) so the inbox shows
  the top 3, not 33.

## 7. Metrics (cheap and honest first)

`PR throughput`, `cost per PR` (split per stage), `cycle time kickoff→merge`, `PR→first human review`,
`autonomy` (human touchpoints per PR), `automation %`, `incident/bug rate per PR`.
Skip "savings vs human work" until there is a real baseline.

## 8. Security boundaries

1. **Inference credentials** — orchestrator only; never in sandbox.
2. **Execution secrets** — injected per-tool into the runner, scoped, rotated by name reference.
3. **Harness auth** — per-adapter, per-agent (`credentialStrategy: executor | creator`).
4. **Repo identity** — short-lived GitHub App token per run; never a long-lived PAT.

Plus: per-agent tool allow/deny lists (Warp lacks this), untrusted-content framing on webhook payloads,
`skip_bots` default, and a global kill switch.

## 9. UI map (nav parity + deliberate improvements)

Top level: `New Chat · Inbox · Runs · MCPs and apps · Secrets · Users`
Per factory: `Dashboard · Agents · Automations · Scorers · Self-improvement · Benchmarks ·
Definition · Gates · Settings`

Deliberate improvements over the reference:
- **Definition** promoted to first-class: diff, history, clone, compare-versions, "what changed this week".
- **Gates** gets its own page (which stages need a human, who approves, SLA, escalation) — absent in Warp.
- **Runs** show per-stage cost and a link to the exact `definitionCommit`.
- **Self-improvement** clustered by root cause with impact score.
- **Benchmarks** can compare *factory versions*, not just models.
