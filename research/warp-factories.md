# Warp Factories — implementation-grade brief

Research date: 2026-10-28. Sources: `docs.warp.dev/factories/*` (fetched as `.md`), warp.dev blog posts (Aug–Oct 2026), and `github.com/warpdotdev/warp-factory-examples` (schema `v1alpha1`).
Everything below quotes real field names from the docs/examples repo. Nothing is invented; gaps are listed at the end.

---

## 1. Concept model

**Work item** — "one request the factory acts on. This can be an issue, a support thread, a pull request, or a scheduled job. It keeps its source context from intake to handoff, however many agents contribute along the way." It is the durable record: identity, stage, links to issue/PR/spec, and the foreman conversation. Observed stage labels (Slack Home tab grouping): `Triage`, `Planning`, `Building`, `Reviewing`, `Complete`, `Cancelled` — the `factory`/`work_item_stage_changed` trigger's allowed `stages` filter values are never enumerated in docs.

**Foreman** — the coordinating agent and the *only* agent that talks to the end user. It accepts work, dispatches stage agents, relays questions/answers both ways, decides which stages to skip, sends work back for revisions, and closes the work item. Its handle (`alias`) is what you @-mention: factory `payments` → `@payments` in Slack/Linear. Exactly one agent per factory declares `agentType: FOREMAN` (alias `MAIN`).

**Factory agents** — a team of agents, each bound to one stage of the SDLC. Defaults: `TRIAGE`, `SPEC`, `IMPLEMENT`, `REVIEW`; `agentType` also allows `VERIFY` and `CUSTOM`. Stages and agents are named separately: the spec agent works the *planning* stage, the implement agent the *building* stage, the review agent the *reviewing* stage. Defaults ship with built-in GitHub skills (foreman also Slack; Linear/Jira add that tracker's skill). Custom agents get no built-in skills.

**Stages** — the pipeline positions a work item moves through. The foreman "picks the shortest path that still meets your quality policy: it skips stages when the work is already well defined, starts partway through when enough context exists, and sends work back to an earlier agent when revisions are needed." Documented stage set is triage → planning → building → reviewing → handoff, plus terminal `Complete` / `Cancelled`. Blog posts describe the full loop as **triage → spec → implement → review → verify → ship → monitor**, where `verify` and `monitor` are usually implemented as separate single-purpose factories/automations rather than default stage agents.

**Checkpoints** — points where the factory pauses for a human. Default three: spec approval, answering clarifying questions, PR handoff/merge. Only the first two are policy (they live in the foreman's instructions); merge is enforced by the repository.

**Work sources** — everything that can create a work item: Slack, Microsoft Teams, GitHub, GitLab, Azure DevOps, Linear, Jira, custom webhooks, factory endpoints (`POST /factory/{uid}/runs`), Factory MCP (`send_task`), direct runs (New Chat / Runs → New), and scheduled automations (`provider: schedule`).

**Execution** — "Every agent run in a factory is an ordinary cloud agent run on the Automation Platform." Each run has a model, harness, runner, environment, secrets, MCP servers, and a sandbox (Warp-hosted or managed self-hosted worker); child runs are tracked under the foreman's run.

**Factory definition** — a versioned tree of YAML/Markdown rooted at `factory.yaml`, hosted either Warp-managed (edited in the web app, committed by Warp, repo hidden) or GitHub-backed (your repo, merges to the production branch apply it). Declares repositories, agents, automations, runners, routers, benchmarks, scorers, skills, webhooks, secrets references, MCP servers, cloud providers, integrations, and execution defaults. Work items, runs, and metrics live in the web app, *not* in the definition.

---

## 2. Lifecycle

Documented flow (`how-factories-work`):

```
Intake → Foreman → Triage →(plan needed?)→ Planning → Human review (default policy) → Building
      → Reviewing →(revision needed?)→ Building … → Human handoff →(merge notification)→ Complete
```

Stage by stage:

1. **Intake.** A work item enters from an integration event, an automation, a direct run, or Factory MCP. Automations filter events/schedules and select an agent; direct requests go straight to the foreman. Source context (thread, issue, PR) is attached and preserved.
2. **Triage.** The triage agent researches the request, reproduces the problem *only if research can't establish the cause*, finds or creates the tracking issue, sets metadata (project, t-shirt size, priority), and reports scope, complexity (`XS/S/M/L/XL`), ambiguity, and open questions. Foreman skips triage when the request already explains problem + change, or when the user supplied a work item (issue/PR link — adopt it instead).
3. **Planning (spec).** The spec agent interviews the human (batched questions relayed through the foreman), then writes product and/or technical specs **committed as a file on a new branch, opened as a draft PR**. The implement agent reuses that branch/PR — never a second PR. Foreman skips planning for small, well-understood changes, and by default asks the user first whether a spec is warranted.
4. **Building.** Implement makes the minimal correct change on the spec branch (or its own), adds tests, runs repo checks, captures computer-use visual proof for UI changes, self-reviews the diff, then opens/marks-ready the PR with an attribution comment and the factory label, and assigns the requester as reviewer. It never merges.
5. **Reviewing.** Review reads issue + spec, treats the diff adversarially, verifies claims and test coverage, and returns a **findings report only** — it never posts on the PR. Each finding: location (file:line), severity, problem, impact, correction, classified `unambiguous` vs `ambiguous`. Verdict: `accepted` | `revision needed` | `human decision needed`. The foreman decides: unambiguous findings → send back to implement (same conversation); ambiguous → post those findings as a PR review and wait for the human. In Warp's own default foreman prompt, review runs **once per work item** — it is not re-dispatched on the revised PR.
6. **Human handoff.** Foreman presents PR + evidence + findings in the originating thread, applies `factory:<alias>` label everywhere, and stops. "Stopping here is not completion."
7. **Complete / Cancelled.** Default: complete after a merge notification or user confirmation the PR landed. The foreman calls `complete_task` with its own run id, which "is idempotent and only ever sets COMPLETE". A cancellation stops work early. "Nothing else completes a task for you, so a task that you never complete stays open forever."

**What triggers transitions.** Event/automation match (provider + event + filters), a direct request, a human reply in the source thread, a follow-up message to a run, `factory` / `work_item_stage_changed`, or a merge/close notification (default GitHub automation `pull_request_merged` / `pull_request_closed`, no-op on unmerged close).

**Who can send work back.** The foreman, to any earlier agent, reusing that agent's existing conversation (`idleTimeoutMinutes`, default 10 min, 60 for orchestrated children). Documented routing: user's answer → the agent that asked; review findings → implement; CI failure on a delivered PR → implement; spec feedback → spec. A reply in the same thread/issue/PR continues the *same* work item rather than creating a new one; duplicate event deliveries don't create duplicates.

**Skipping and partial entry.** Work can enter at any stage: a PR needing review, a PR needing comments addressed, a CI failure, a merge notification, or a reply to an earlier question. Informational questions ("can we do X?") are routed to triage but instructed *not* to create a work item.

---

## 3. Human-in-the-loop model

Three default pauses, per `how-factories-work`:

| Decision | Default | Enforced by |
|---|---|---|
| Spec approval | Implementation waits for a person to sign off | Workflow policy in the foreman's instructions (editable) |
| Clarifying questions | Foreman asks instead of guessing | Workflow policy in the foreman's instructions (editable) |
| Merging | Factory opens PR and hands off; never merges | Repository permissions + branch protection |

The doc is explicit about the separation: "Spec approval is part of the foreman's editable instructions, not a repository permission." And on access: "What an agent can reach comes from its configuration and the permissions of the connected providers, never from its instructions — changing what an agent is told to do doesn't change what it's able to do."

**What Warp explicitly refuses to automate.** Merging: "The factory never merges on your behalf" — implement "never merges", review "doesn't approve or merge the pull request" and its verdict is advisory. PR approval: review agents don't submit approve/request-changes reviews; the foreman posts findings as a plain review. Self-approval of the definition: definition changes are ordinary PRs, and although a factory Admin can force-merge a blocked one, the flow is review-gated by default via `warp/factory-config`.

**Other human surfaces.** Steering a live run ("View session" → shared agent session, follow-ups while the sandbox is alive; `POST /agent/runs/{runId}/followups`); Stop run (immediate, no confirmation); resolving Inbox items; "Run now" for self-improvement; approving/merging self-improvement PRs. **Is "lights off" achievable?** Not inside the product as shipped. There is no config flag that enables auto-merge; the only merge path is the repo. Measured reality: Warp reports ~20–30% of PRs/issues automatable end-to-end, ~30% of tasks, and ~75% of changes to their marketing site going through the factory "with minimal human touchpoints besides describing the change". The `Autonomy` metric is precisely "share of merged PRs that needed no human code push before merging" — opening the PR counts as a push, comments/reviews/merge do not. So lights-off requires you to add a merge policy *outside* the factory (auto-merge on green + label + branch protection exemption), which is exactly the gap our product should fill.

---

## 4. Definitions as code

### Layout (from docs; per-resource paths collapsed)

```
factory.yaml
agents/<name>/agent.md              + optional agents/<name>/skills/<skill>/SKILL.md
automations/<name>/automation.md
runners/<name>.yaml
routers/<name>.yaml
benchmarks/<suite>/suite.yaml       + tasks/<task>.yaml
scorers/<name>/scorer.md
skills/<skill>/SKILL.md
webhooks/<name>.yaml
```

Rules from the examples README: **a resource's name is its path** (`agents/<name>/agent.md`, `automations/<name>/automation.md`, `runners/<name>.yaml`, `scorers/<name>/scorer.md`) — renaming means moving the file. Exactly one agent declares `agentType: FOREMAN` (alias `MAIN`). `model` and `harness` are **mutually exclusive everywhere**; `agentDefaults` must declare exactly one. Declaring `secrets` or `mcpServers` on an agent or automation **replaces** the inherited list, it does not merge. `skills/` = every agent; `agents/<name>/skills/` = that agent only.

### `factory.yaml` (verbatim, `01-single-repo-quickstart`)

```yaml
schemaVersion: v1alpha1
name: single-repo-quickstart
description: >-
  The smallest useful factory: one repository, a foreman that routes work, an
  implementation agent that turns labeled issues into pull requests.
alias: Quickstart
repositories:
  - owner: acme
    name: api-service
agentDefaults:
  model: auto
  runner: linux-small
```

Fields: `schemaVersion` (required, `v1alpha1`), `name` (required), `description`, `alias` (≤60 chars, letters/numbers/space/`.`/`_`/`-`, case-insensitively unique per workspace), `credentialStrategy` (`EXECUTOR` default | `CREATOR`, paid plan), `automations.githubOnboardingNotices` (default `true`), `codeForges` (`GITHUB`|`GITLAB`|`AZURE_DEVOPS`), `repositories[]` (`owner`, `name`, optional `codeForge`; required when multiple forges), `benchmarkRepoSubstitutions` (source/target, both `GITHUB`, source in factory, target not), `secrets[]` (factory-wide grants), `mcpServers{}`, `cloudProviders` (`aws.roleArn`, `gcp.projectNumber`, `gcp.workloadIdentityFederationPoolId`, `gcp.workloadIdentityFederationProviderId`, `gcp.serviceAccountEmail`), `integrations[]` (`slack`, `microsoft-teams`, `linear`, `jira`; at most one issue tracker; `autoRespondToThreadReplies`), `scorerDefaults` (`runner`, `secrets`, `mcpServers`), `selfImprovement` (`failedRunThreshold` 1–50, `reviewerType` `admins`|`team`|`custom`|`none`, `reviewerEmails`), `agentDefaults`.

`agentDefaults`: exactly one of `model` or `harness`; plus `runner`, `environmentId`, `secrets`, `mcpServers`, `workerHost` (`warp` or worker ID; `null`/`""` clears an inherited host), `computerUseModel` (`computer-use-agent-auto` or a suffixed model id, e.g. `claude-5-sonnet-high`; only meaningful on `type: oz`).

**Model/harness routing declaration.** `model: auto` is *shorthand* for `harness: {type: oz, model: auto}`. Harness types: `oz`, `claude`, `codex`, `claude-code` (alias for `claude`). Optional `reasoningLevel`. Auth:

```yaml
harness:
  type: codex
  model: gpt-5.3-codex
  reasoningLevel: high
  auth:
    source: managedSecret
    secretName: CODEX_API_KEY
```

`auth.source`: `managedSecret` (requires `secretName`) or `workerEnvironment` (requires a self-hosted `workerHost`; `secretName` not allowed). The `oz` harness supplies its own credentials and **rejects** `auth` and `reasoningLevel`. Agents may select a **custom router** by file name anywhere a model is accepted.

### `agents/<name>/agent.md` (verbatim, `03-multi-harness`)

```markdown
---
description: Implements scoped issues on the Claude Code harness.
agentType: IMPLEMENT
runner: linux-arm64
harness:
  type: claude
  model: opus
  auth:
    source: managedSecret
    secretName: ANTHROPIC_API_KEY
---
# Implementation

You are the implementation agent of this factory, running on the Claude Code
harness. You make the change the work item describes, prove that it works,
and deliver it as a pull request that is ready for review.
```

Frontmatter keys (all optional): `description`, `agentType` (`CUSTOM` default, `FOREMAN`/`MAIN`, `TRIAGE`, `SPEC`, `IMPLEMENT`, `REVIEW`, `VERIFY`), `credentialStrategy`, `spawnableBy` (omit → foreman only; `[]` → nobody; else exact agent names), `model`|`harness`, `runner`, `environmentId`, `secrets`, `mcpServers`, `workerHost`, `computerUseModel`, `idleTimeoutMinutes` (1–60). Body = instructions.

Dispatch mechanics: foreman calls `run_agents` with `remote` set and `agent_run_configs[].agent_identity_uid` = the chosen agent's UID; `name` only labels the child run. Unspecified config inherits the selected agent's environment/runner/host/harness/model.

### `automations/<name>/automation.md` (verbatim, `01`)

```markdown
---
triggers:
  - provider: github
    event: issue_labeled
    filter:
      repos: [acme/api-service]
      labels: [factory-ready]
---
A maintainer labeled an issue `factory-ready`. Read the issue, restate the
deliverable, and drive it to a pull request. Post progress as comments on
the issue.
```

Fields: `enabled` (default `true`), `agent` (default foreman), `triggers[]` (`provider`, `event`, optional `filter`, `schedule` for cron), `displayName`, and execution overrides (`model`|`harness`, `runner`, `environmentId`, `secrets`, `mcpServers`, `workerHost`, `computerUseModel`, `idleTimeoutMinutes`) which override the target agent for that automation's runs.

Providers/events: `github` (issues: created/labeled/assigned/commented/mentioned; PRs: opened/ready/reopened/synchronized/labeled/assigned/mentioned/closed/merged/enqueued/dequeued/commented; reviews: requested/submitted; CI: `push`, `check_suite_completed`, `check_suite_rerequested`, `check_run_rerequested`, `workflow_run_completed`), `gitlab` (`merge_request`, `bot_mentioned`, `push`), `azure_devops` (PR created/updated/closed/merged/commented/mentioned, work_item created/assigned/labeled/mentioned, `push`), `linear` (`agent_session_created`, `comment_created`, `issue_created|assigned|labeled`, `issue_state_changed`), `jira` (`agent_session_created`, `issue_created`, `issue_labeled`, `status_changed`), `slack` (`app_mention`, `message_dm`, `message_posted`, `reaction_added`, `member_joined_channel`, `message_im|mpim`), `teams` (`app_mention`, `message_posted`), `webhook` (`received`), `schedule` (`cron_fired`), `factory` (`work_item_stage_changed`).

Matching: every filter key ANDs; within an inclusion list any value matches; `not_in` excludes; omitted optional lists don't restrict but provider defaults apply (GitHub `skip_bots` defaults to `all`). Aliases (`teams`/`projects`/`states`/`issues`/`channels`/`users`/`itemUsers`, `baseBranches`, `prNumbers`) resolve to `_ids`/snake-case canonicals and are mutually exclusive with them.

### `runners/<name>.yaml` (verbatim, `02-sdlc-issue-to-pr`)

```yaml
description: >-
  Build runner for implementation: double the compute of the default, on an
  image that already carries the Go toolchain.
setupCommands:
  # A setup command that exits non-zero fails the whole sandbox, so anything
  # best-effort has to swallow its own failure.
  - '(cd /workspace/api-service && go mod download) || echo "Warning: module prefetch skipped" >&2'
instanceShape:
  vcpus: 8
  memoryGb: 16
platform:
  os: linux
  arch: x86_64
  linux:
    dockerImage: golang:1.24-bookworm
```

Also `failureSessionRetentionMinutes` (1–60); `platform.mac.version` (`"14"|"15"|"26"|"27"`, quoted, default `"26"`); `platform.linux.registryCredentialSecretName` (must be a `docker_registry` or `aws_ecr_credential` managed secret whose registry host matches the image). Linux/Windows sizes must be powers of two; macOS has a fixed menu (4/7, 6/14, 8/14, 12/28, 12/56). Setup commands run in order, then the environment's; non-zero exit or >30 min fails the run during setup.

### `routers/<name>.yaml`

Fields: `name` (optional label), `type` (`complexity`|`prompt`), `default` (concrete model used when no route matches), `routing`. `complexity` maps `routing.easy|medium|hard` to models; `prompt` is an ordered list of `{description, model}`. Targets must be concrete models — not Auto, not another router. Referenced by file name anywhere a model is accepted.

### `scorers/<name>/scorer.md` (verbatim, `02`)

```markdown
---
description: Did the run deliver what the work item asked for, and only that?
agents:
  - implementer
labels:
  - value: compliant
    description: The PR delivers the work item's request, scoped to it.
    score: 1
  - value: partial
    description: The PR delivers some of the request or adds unrequested scope.
    score: 0.5
  - value: non_compliant
    description: The PR does not deliver the request.
    score: 0
passingScore: 1
samplingRate: 25
model: claude-4-5-haiku
selfImprovement: true
---
Compare the pull request against the work item the run was dispatched with.
Return `compliant` when the change delivers exactly what the work item asks
for; `partial` when it delivers a subset or adds unrequested scope; otherwise
`non_compliant`. Judge scope from the issue text, not from the PR's own
description of itself.
```

Fields: `name` (required), `description`, `output` (`classification` is the only supported value), `passingScore` (0–1, required), `samplingRate` (default `25`, 0 disables), `model` (required judge), `selfImprovement` (default `false`), `agents[]` (string, or `{name, includeDescendants: true}` to pull child runs in as evidence), `runner`/`secrets`/`mcpServers` overrides. `labels`: 1–20 entries, each `{value, description?, score 0–1}`; at least one must meet `passingScore` and one must fall below it.

### `benchmarks/<suite>/suite.yaml` + task (verbatim from docs)

```yaml
name: Pull request review
description: Compare configurations for the review agent.
agent: reviewer
configurations:
  - name: Baseline
    agents:
      - agent: reviewer
        model: auto
  - name: Candidate
    agents:
      - agent: reviewer
        model: auto-efficient
tasks:
  - broken-doc-link
```

```yaml
title: Fix a broken documentation link
prompt: Find the broken internal documentation link and update it.
successCriteria: The destination resolves and the link text names the destination.
startingRepoRefs:
  - github.com:acme/payments-docs@0123456789abcdef0123456789abcdef01234567
```

Suite: `name` (unique per factory), `description`, `agent` (required — one agent for every task), `configurations` (1–6, each unique `name`, optional `agents[]` pinning `{agent, model|harness}`), `tasks` (ordered unique slugs; every file under `tasks/` exactly once; a suite with no tasks saves but cannot run). Task: `title`, `prompt`, `successCriteria` (fed to the built-in Correctness Scorer), `sourceRunId`, `tags[]`, `linearSeed` (JSON starting state for an isolated Linear workspace), `startingRepoRefs` (full 40-char commit SHAs only — no branches/tags).

### `webhooks/<name>.yaml`

Keys: `enabled` (default `true`), `authMode`, `signatureScheme`, `secretName` (required), `deliveryIdHeader`. `authMode`: `token` (default, `Authorization: Bearer`), `url_token` (secret as a path segment; the URL is the credential), `signature` (requires `signatureScheme`: `github`|`pagerduty`|`sentry`|`standard_webhooks`|`stripe`|`vercel`). `secretName` must reference an existing managed secret. `authMode`/`signatureScheme` are immutable after creation — delete and recreate. Max 20 webhooks per factory.

### Skills (excerpt, `02`)

```markdown
---
name: repository-conventions
description: Shared conventions for branches, commits, tests, and PRs in the acme repositories. Use before creating branches, commits, or pull requests.
---
# Repository conventions
- Branches: `factory/<work-item-id>-<slug>`.
```

Skills give *instructions*, not access: "Skills provide instructions, not access to tools or repositories." Credentials/MCP must be configured on the agent.

### Validation & schema publication

- JSON Schemas (unauthenticated): `https://app.warp.dev/api/v1/factory-files/schemas` (versions), `…/schemas/v1alpha1` (all docs), `…/schemas/v1alpha1/<document>`. Documents: `factory.schema.json`, `agent.schema.json`, `automation.schema.json`, `scorer.schema.json`, `runner.schema.json`, `router.schema.json`, `webhook.schema.json`, `benchmark_suite.schema.json`, `benchmark_suite_task.schema.json`, `common.schema.json`.
- Editor wiring: `# yaml-language-server: $schema=https://app.warp.dev/api/v1/factory-files/schemas/v1alpha1/factory.schema.json` (validates YAML only, not Markdown frontmatter).
- CLI/CI: `python3 scripts/validate_factory_files.py FACTORY_ROOT` from the examples repo — submits factory, agent, automation, runner, scorer files to Warp's validation service; **does not** submit routers, benchmarks, webhooks, or skills. No login required, but network required.
- PR gate: `warp/factory-config` check validates the head commit and dry-runs the change against your team, catching nonexistent secrets/runners/MCP servers/models; passes with a create/update/delete summary. If the definition is in a subdirectory the check name appends it: `warp/factory-config (factory)`. Unchanged definitions pass immediately.
- Apply semantics: "Warp applies the definition as one unit and keeps the last valid definition if validation fails."

---

## 5. Runners & infrastructure

**Control plane / execution plane.** Warp owns coordination, identity/config, observability, integrations, storage, and inference routing. A Warp-hosted sandbox or a managed self-hosted worker checks out code, runs setup, invokes tools, builds, executes commands.

| | Warp-hosted | Managed self-hosted |
|---|---|---|
| Compute | Warp provisions | You provision the worker |
| Checkout/commands | Warp-managed compute | Your infrastructure |
| Network | Warp manages sandbox connectivity | Worker connects **outbound**; no inbound port |
| Private services | Must be publicly reachable | Reachable via worker network |
| Ops | Warp | You (capacity, isolation, updates, availability) |
| Plan | any | Enterprise only |

**Hosted sandboxes.** Linux = fresh Docker container per run, default image `warpdotdev/dev-base:latest`, x86-64 or aarch64, must have `bash` + coreutils; can itself run Docker containers and KVM VMs (Android emulator). macOS = fresh Apple Silicon VM, Xcode + simulators preinstalled, Homebrew/package-manager downloads cached. Windows = fresh VM, x86-64 only, PowerShell-compatible setup commands. Egress on by default; allowlist via Warp's published IP ranges (Admin Panel → Platform, or web app settings). Concurrency is capped per team and excess runs queue. Enterprise up to 32 vCPU / 64 GiB (custom provisioning on request).

**Managed self-hosted.** `oz-agent-worker` connects to the Automation Platform, waits for tasks addressed to its worker ID, and executes with the configured backend: **Docker** (default, one container per task), **Kubernetes** (one Job in the worker's namespace, `pod_template` schedules nodes), **Direct** (separate workspace on the worker host, shares OS/kernel), **Command** (hands the task to an external job API/queue), **One-shot Direct** (external scheduler starts one Direct worker per task). Task platform depends on backend (Docker/K8s ⇒ Linux tasks; Direct ⇒ host OS). Multiple long-lived workers may share an ID for load balancing; one-shot Direct needs a unique ID per job. Credentials: self-hosted worker API key as `WARP_API_KEY` / `--api-key`; unattended run creation uses an agent API key tied to the **Default Service Account**. Routing: definition `agentDefaults.workerHost`, API `config.worker_host`, CLI `--host`. Worker config owns capacity/registry/volumes/placement; runner settings **do not provision capacity** (Direct ignores `instanceShape` and `dockerImage`; K8s/Docker apply them as container requests/limits).

**Isolation.** Each agent runs in its own cloud environment (Docker, k8s, or direct) — "agents are isolated from each other to separate secret and MCP server access" (blog). Per-agent runners mean per-agent blast radius and per-agent compute cost (e.g. macOS only for Swift builds).

**Four credential boundaries** (this is the cleanest part of the design):

| Credential | Used for | Boundary |
|---|---|---|
| Inference | Warp Agent model requests | Used only at the Warp↔provider boundary; **never injected into the sandbox** |
| Execution secrets | APIs, registries, tools | Explicit per-agent allowlist, injected as env vars named after the secret |
| Harness auth | Claude Code / Codex | Used **inside** the execution env for direct provider calls; configured separately from the secret allowlist |
| Repository identity | Clone/push | `credentialStrategy`: `EXECUTOR` (run identity) or `CREATOR` (creating user, changes attributed to them) |

Defaults: "Factory agents that don't act as a specific user receive no managed secrets by default." Redaction of known secret values at output boundaries is a "backstop, not a substitute for narrow external permissions and rotation." Per-entry secret size limit: 128 KiB including the terminating null byte. Secrets are team-scoped (not per-factory); granting is explicit via factory-wide `secrets`, `agentDefaults.secrets`, or per-agent `secrets` (replace semantics). AWS ECR credentials are a separate secret type: IAM role ARN + region, short-lived token per run, registry host derived from account ID + region, never injected into the agent env.

**Roles.** Team-level Warp Factories role: admins/owners and team Editors can create factories. Per-factory: `User` (view/run, propose definition changes), `Editor` (edit definition, configure agents/repos/automations, attach existing integrations/secrets/MCP, select existing runners), `Admin` (manage members, delete factory, force-merge blocked definition changes). Factory roles do **not** control spec approval or PR review.

---

## 6. Measure & improve

### Metrics (`factory-dashboard`, `measure-and-improve`)

- **Total runs** — all agent runs, broken down by agent type, status, source, model.
- **PRs opened** — counted once, in the period first observed.
- **PRs merged** — of PRs opened in a period, how many later merged (different data source; merged can read higher than opened for a window).
- **Autonomy** — share of merged PRs needing no human code push before merge. Opening the PR counts as a push; comments, reviews, requested changes, and the merge do not.
- **PR cycle time** — median from run kickoff → PR → first review → merge, with an independent median per stage ("the stage medians don't sum to the headline").
- **Cost per PR** — median cost of PRs opened in range; a run's cost includes child runs and splits evenly across the PRs it produces; breakable by cost component (compute/platform/inference) and PR size S/M/L/XL (split at 100/500/1,000 changed lines). An estimate, not a billing figure.
- **Most expensive PRs**, **Scorer cards**, **Self-improvement PRs** (three newest, ignoring the date range). Blog-level KPI set: PR throughput, average cost per PR, **automation percent** (average human touchpoints per PR), **savings over human work**, acceleration of shipped product. Caveat: `PRs merged`, `Autonomy`, `PR cycle time`, and the `Most expensive PRs` detail need a connected code host and cover only post-connection activity.

### Scorer design

LLM-as-a-judge that returns a **classification, not a numeric grade** — "keep each one focused on a question its failures can point back to". Input is the full run trace: turn-by-turn conversation, tool calls, MCP results, input images, and artifacts (PRs, specs, screenshots). Fields: agents to evaluate (optionally including descendants), judge instructions (body), judge model, classifications with scores, pass threshold, sample rate. Default sample rate 25%; scoring costs ~3% of total token spend in Warp's own factory. On-demand scoring of a single run replaces that scorer's prior result — the intended way to test new judge instructions before raising the rate. Cadence is "after they complete" for sampled runs, plus manual. Warp ships default scorers: task compliance, procedure compliance, verbosity, efficiency, code quality. Their published rubrics live in `github.com/warpdotdev/common-skills` under `.agents/skills/skill-doctor/scorers/`.

### Self-improvement loop

- Opt-in per scorer via `selfImprovement: true`. A failure = score below `passingScore`.
- Default schedule: after an agent accumulates **25 distinct unreviewed failures**, or when its oldest unreviewed failure is **7 days old**. `selfImprovement.failedRunThreshold` (1–50) tunes it; `reviewerType` (`admins` default, `team`, `custom`+`reviewerEmails`, `none`) picks who gets asked — Warp randomly requests one eligible reviewer.
- Mechanism: batch failures per agent into one follow-up run; the observer agent triages them, searches transcripts for evidence of *why* each failed, and proposes a diff. Output is a review branch (Warp-managed) or a PR (GitHub-backed), with a standard **"Regressions addressed"** section linking the failing runs and scorer results.
- **Knobs it may change:** prompts, skills, agent configuration (model/harness routing, runners), and application code. Warp's own guidance to the loop: redraft skills holistically rather than appending addenda, delete outdated guidance, hold skill changes to the same code-quality bar.
- **Guardrails:** nothing is adopted without review; every proposal is a PR/review branch; definition changes still pass `warp/factory-config`; a factory Admin can force-merge a blocked definition change (explicit escape hatch). `Run now` triggers an ad hoc pass that can include an agent with a single failure but you cannot choose which agents/failures.
- Reported wins: DOM/computed-styles requirement for visual capture (after 275 computer-use actions to verify a one-line CSS fix), a "Design" dimension in code-quality guidance, cutting no-op subagent messages, fixing broken skill references, Slack heartbeats, enforcing orchestrator→specialist routing.

### Benchmarks

One agent per suite; fixed task set; configurations vary model/harness/runner. A **trial** = one run of one task under one configuration; **repetitions** multiply trials. Launch dialog picks configurations (or 1–6 presets), scorers, repetitions; shows trial count and warns that more trials/scorers cost more. Trials that reach a terminal state are scored; a **Blocked** trial stays Blocked but can still be scored on the evidence it produced. Inputs are frozen at launch, so later suite edits don't change past results. Cancellable during run or scoring.

Results: **Overall recommendation** (highest quality when ≥2 configurations are comparable), **Additional recommendations** (most efficient, lowest cost), comparison chart, overall table (per-scorer average + combined Overall, expandable to configuration→task→repetition→trial), scorer grids (per-task results across configurations). Total cost includes trials + scorer usage; "Run time" is wall-clock, not billable agent time. Failed/cancelled runs show only what finished scoring.

WarpBench case study: curated S/M/L/XL tasks from real traces (server Go/React, client Rust), harness held constant (Warp Agent), models Opus 5 / GPT-5 Sol / Gemini 3.7 / Grok 4.6 / GLM 5.3 flash; setup <30 min; replay by rehydrating git at the original commit **and pinning the factory definition at that point in time**; result: cost/PR $80 → $30 with no quality drop, task compliance 69% → 83%, then GPT-5.6 Sol for a further ~25%. Explicitly *not* yet supported: cross-harness benchmarking, true A/B testing in production.

---

## 7. API / MCP / integrations

**Base URL** `https://app.warp.dev/api/v1`. Auth: `Authorization: Bearer $WARP_API_KEY` (`wk-…`). Personal key attributes runs to you; agent key attributes to a cloud agent; unattended creation should use an agent key bound to the **Default Service Account**. SDKs: `warp-platform-sdk` (PyPI, sync+async, typed, retries/timeouts, structured errors) and `@warp-dot-dev/warp-platform-sdk` (npm), both exposing `client.factories.list/get`, `client.factories.runs.create`, `client.agent.runs.retrieve`.

**Factory endpoints** (discover + dispatch, no agent internals): `GET /factory?search=` (list/search by name or alias, case-insensitive, paginated), `GET /factory/{uid}`, and `POST /factory/{uid}/runs` with body `{prompt, title?, ticket_ref?, ticket_url?}` — only `prompt` required, `title` derived from the prompt if omitted, `ticket_ref` in `<source>:<id>` form (`linear:PAY-123`, `jira:PROJ-456`); returns `run_id`, `run_url`, `state`.

**Agent & run endpoints:** `POST /agent/runs` (`prompt`, optional `config`, `title`), `GET /agent/runs` (filters: state, `config_name`, `model_id`, creator, source, time), `GET /agent/runs/{runId}` (session link + resolved `agent_config`), `POST /agent/runs/{runId}/followups` (`{message}`), `POST /agent/runs/{runId}/cancel`. States: `QUEUED`, `INPROGRESS`, `SUCCEEDED`, `FAILED` (plus others in the reference); `status_message` carries the error.

**AmbientAgentConfig**: `name` (label for grouping/filtering; auto-set to skill name when run from a skill), `model_id`, `base_prompt`, `environment_id`, `worker_host`, `skill_spec` (`owner/repo:skill-name` or `owner/repo:path/to/SKILL.md`), `mcp_servers`.

**Webhooks (inbound).** Ingress `https://app.warp.dev/webhooks/w/{WEBHOOK_UID}`. Contract: `POST` only, JSON body ≤256 KB, `Content-Type` not enforced; `202 {delivery_id}` accepted, `401` auth, `400` invalid JSON, `404` unknown/disabled/deleted, `413` too large, `429` + `Retry-After` above 60 deliveries/min. Dedup identity precedence: configured `deliveryIdHeader` → provider delivery header (e.g. `X-GitHub-Delivery`) → `X-Warp-Delivery-Id` → body hash; a duplicate returns `202` and starts nothing. No ordering guarantee, no thread continuation. Payload filter grammar: bare array = `in`; operators `in`/`not_in`/`exists`; nesting ≤10 levels, ≤64 leaf fields, ≤32 values per set; missing key fails `in`, passes `not_in`; same value in `in` and `not_in` rejected; **fail closed**. Runs receive the automation prompt plus a platform envelope naming webhook + delivery and attaching `event-payload.json`, with explicit framing that embedded payload content is **untrusted context** (prompt-injection defense). Delivery log keeps ≥50 recent deliveries / 7 days, labeled `Accepted`/`Duplicate`/`Rejected (auth|invalid JSON|too large)`.

**Factory MCP.** Streamable HTTP at `https://app.warp.dev/api/v1/mcp/factory`; browser OAuth on first connect, or `Authorization: Bearer` agent key for headless. One connection reaches every accessible factory. **No read-only or per-factory scopes** — the client acts with the full permissions of the account/agent it authenticates as. Tools: `list_factories`, `get_factory_file_schema`, `validate_factory_files`, `list_teams`, `create_team`, `join_team`, `get_team_funding_status`, `list_forge_repositories`, `list_tracker_scopes`, `start_connection`, `get_connection_status`, `create_factory`, `list_tasks`, `search_task`, `get_task`, `message_foreman`, `get_conversation`, `send_task`, `list_notification_routes`, `complete_task`. Notable semantics: `get_task(start_working=true)` returns status, run history, and *suggested* git commands for an isolated worktree — "Factory MCP never modifies your files"; picking up a task does **not** claim/lock/pause it; `send_task` on an existing task id hands work back; `complete_task` is what closes it; notifications via `list_notification_routes` are best-effort.

**GitHub.** One App installation serves platform + factories. Default automations: mentions/assignments, issue+PR labeled, review submitted, PR closed/merged. Routing label `factory:<alias>` created with the factory; mention **@warp** (or the configured handle) in a new body/comment; edits and code-block mentions ignored. Unlabeled mentions route only if exactly one accessible factory; otherwise Warp asks for the label. Bot events skipped by default (`skip_bots: all`; `self` = Warp-owned only; `none` = all, risks feedback loops). Branches/PRs obey branch protection and required reviews. `warp/factory-config` check as above.

**GitLab.** Requires GitLab.com + Premium/Ultimate (group webhooks) + Owner of a top-level group. Warp creates one **manager service account** per workspace (Owner on the group; 1-year provisioning token) and one **bot account per factory** (`<alias>-warp-<shortid>`, Developer on exactly the selected projects). Runs authenticate as the bot; anyone who can comment can start work (no Warp membership required). Branches `factory/<slug>`; MRs open as drafts and are marked ready; review = summary note + inline discussions, resolved in-thread on revision. Label `factory:<Foreman name>`. Never merges/approves. GitLab is not supported as a definition-hosting repo.

**Azure DevOps.** `dev.azure.com` only (Server → other-code-forges path). Per-factory **Microsoft Entra app + service principal** ("factory identity") created by an org-level **Azure DevOps Manager** (Basic access + Project Collection Administrators). Admin approvals: Entra Global/Privileged Role Admin for `Application.ReadWrite.OwnedBy`; Azure DevOps PCA for Basic + PCA membership. Each Manager and each factory identity consumes a Basic seat. Automations additionally check the **automation creator's** OAuth connection before each run.

**Linear / Jira.** Linear: agent sessions (`agent_session_created`) are the primary path; assigning/mentioning/delegating the Warp app starts one. Session routing is **not** editable in the automation editor (definition file only). Additional triggers: issue created/labeled/state-changed/assigned, comment created. The factory can update state/delegate, attach a PR, link the run; its own activity never re-triggers; repo access comes from the code host, not Linear. Jira: Cloud only; a site admin installs the Warp app (listed among Atlassian Rovo agents) and connects the site to the workspace, then each factory opts in per project. All work arrives via `agent_session_created` filtered by `project_keys` + `keywords` (case-insensitive). Statuses: submitted/working/waiting for input/completed/failed/cancelled. Built-in Jira tools act **as the run creator**, so scheduled/API runs need the Atlassian MCP server instead; the agent doesn't comment unless asked.

**Slack / Teams.** Slack: each factory is its own app with its own name/avatar; multiple factories can share a channel. Reacts 👀 on pickup, posts ack/progress/links in-thread, plain replies continue an existing work item, attachments supported (unsupported ones don't block text). Home tab = kanban grouped by stage with filters. Mention/DM requires the Slack account linked to an active Warp team member; automation-started work runs as the configured agent, not the triggerer. Connecting Slack auto-grants Warp-managed Slack tools (read joined channels/threads, reply in thread, post top-level) — separate from configured MCP servers. Teams: standard + shared channels only (no private channels, no DMs); app package uploaded/approved by a Teams admin, workspace admin connects the team, factory editor picks teams + ≥1 standard channel. Shared channels require users in the install's M365 org with a linked Warp account, new root messages must mention `@Warp`, and agents can read only their originating thread. Channel IDs are `19:…@thread.tacv2`; `team_ids` = one Graph UUID; inclusion-only filters.

---

## 8. Web UI surface

Global sidebar (above the factory list, team-wide unless noted):
- **New Chat** — prompt box + factory dropdown; sends directly to that factory's foreman (this is the "chat = harness front-end" equivalent).
- **Inbox** — single global personal queue (not team-wide, not per-factory). Item kinds: `Asked question`, `Answered question`, `Spec review`, `PR review`, `Blocked`, `Failed`. Only work *you* started. Auto-clears when resolved upstream; manual resolve with Undo; read/unread; filters by factory/read state/kind; search.
- **Runs** — all runs you can access, parents with grouped children; open a run for timeline + cost, a **Sub-agents** tab, `View session` (live steering while sandbox alive, transcript after), Stop run, Score run, "turn into a benchmark task".
- **MCPs and apps** — team-level MCP installs/apps. **Secrets** — team-level list; types `Raw value` and `AWS ECR credential`; per-secret **Agents** tab; create/edit/rotate/delete; "Available to agents" factory selector. **Integrations** — top-level provider connections (Slack, Teams, Jira site, GitLab group, GitHub org, Linear workspace). **User profile / settings** — incl. "Warp-hosted agent networking" IP ranges.

Per-factory pages (select factory in sidebar):
- **Dashboard** — landing metrics page: Autonomy, PR cycle time, Cost per PR (expandable to most expensive PRs, split by cost component / PR size), opened-vs-merged chart, run breakdown, Scorer cards, Self-improvement PRs.
- **Agents** — list of foreman + agents; per-agent **Settings** tab (description, MCPs, secrets, Harness, Model, Host, Runner, Auth) and **Prompt** tab; **New → Custom agent**; agent names immutable after creation.
- **Automations** — list + editor (Triggers, More filters, `Test filter` for webhooks, agent, save). Contains a **Webhooks** tab: create webhook, one-time secret reveal, ingress URL, `Recent deliveries`, Enabled toggle, Rotate secret, Delete. Read-only when the definition lives in an external repo; the editor does **not** expose execution overrides (those are definition-only).
- **Scorers** — create/edit scorers and read results: pass-rate chart over time, graded-run table with score/reasoning/run time/cost, per-run drill-in.
- **Self-improvement** — list of PRs/review branches grouped by repo/agent, each with "Regressions addressed" evidence; **Run now**.
- **Benchmarks** — suite list + `New`; suite editor (name, description, agent, Add task from a completed run or scratch); launch dialog (configurations, harness/model or authorized router, runner, scorers, repetitions, trial count); run results (recommendation, chart, overall table, scorer grids); cancel.
- **Factory definition** — browse/edit definition files (Warp-managed only; hidden for GitHub-backed; absent for "Live-managed" API-managed factories). Saving validates and commits all changes as one unit. Agent-proposed definition changes surface as a **spec review** in Inbox with comment / Request changes / Approve & merge.
- **Settings** — Identity (name, avatar, **Foreman name**), Repositories, **Pull request authorship** (`credentialStrategy`), **Analysis model** (self-improvement's analyzer), Runners (edit default runner, setup commands, private image credential), Integrations, Deletion. Externally managed values are read-only here.

---

## 9. Opinionated takeaways

**Copy exactly**
1. `factory.yaml` + one-resource-per-path (`agents/<name>/agent.md`) with `schemaVersion: v1alpha1` and *published JSON Schemas per document*; Markdown frontmatter for config, body for instructions. Path-is-identity kills name/index drift, and "config in YAML, prose in prose" is the shape agents can safely rewrite.
2. The **four credential boundaries** (inference / execution secrets / harness auth / repo identity). Inference credentials never entering the sandbox is the single most valuable security decision in the design.
3. `credentialStrategy: EXECUTOR | CREATOR` as a first-class, per-agent-overridable field. This is what lets "unattended work" and "act as the requesting human" coexist.
4. Separate `stage` from `agent` vocabulary (triage/planning/building/reviewing ≠ triage/spec/implement/review). It lets you swap agent implementations without rewriting the workflow model.
5. Review agents return **findings reports to the orchestrator**, never post verdicts, never approve. Verdicts are advisory; ambiguous findings escalate to a human.
6. `spawnableBy` as an explicit dispatch allowlist, and `agent_identity_uid` (not name) as the dispatch key.
7. Scorers as **classification + passingScore + samplingRate**, not a 1–10 score. Sampling default 25%, 0 disables. Cheap to run, easy to reason about pass rates.
8. Benchmark suites that pin `startingRepoRefs` to a full commit SHA **and** freeze the factory definition at that point. Replay without config pinning is meaningless.
9. `warp/factory-config` style PR gate that *dry-runs* the definition against real team resources and reports create/update/delete — the missing piece in most IaC setups.
10. Inbox as a **personal** queue (only work you started), not a team feed, auto-resolving on upstream resolution.
11. Webhook payload framing that declares embedded payload content untrusted, plus `skip_bots: all|self|none` with a safe default and an explicit feedback-loop warning. Cheap, effective mitigations for the two most likely self-inflicted failure modes.

**Simplify for a solo/small-team build**
12. Drop managed self-hosting backends (Docker/K8s/Direct/Command/one-shot), `cloudProviders` (AWS/GCP federation), and AWS ECR credentials. One runner protocol, two implementations: local subprocess + remote container. That covers the Mac-first requirement.
13. Collapse `routers/` into a `routing:` block in `factory.yaml` or per-agent (`type: complexity|prompt`, `default`, ordered rules). One fewer resource type, same capability.
14. Skip the four forge integrations. Ship GitHub first (App + label routing + `factory:<alias>`), and treat everything else as "webhook + clone-by-token" (`CODE_FORGE_TOKEN` secret + authenticated `git clone` in `setupCommands`). GitLab/Azure/Teams each cost weeks of identity plumbing. Skip `alias` uniqueness and per-factory Slack apps: one bot, `@factory-<name>`.
15. Keep the metrics that are cheap and honest: PR throughput, cost/PR, cycle time, autonomy. Skip "savings over human work" until you have real human baselines — Warp itself hedges it as an estimate.

**Warp over-engineers (don't copy)**
16. Six self-hosting backends + `pod_template` + one-shot Direct is enterprise-only surface area a small team will never operate. The `computerUseModel` enumeration (30+ suffixed ids, `thinking`/`xhigh-fast`) is a second maintenance liability; one `computer_use_model` string plus provider config is enough.
17. Four webhook auth modes + six signature schemes + the two-step "provider issues secret after URL" dance. `token` + `signature` with HMAC covers ~all real senders.
18. `benchmarkRepoSubstitutions` (GitHub-only source→target remap), `automations.githubOnboardingNotices`, and the legacy `providers` alias — niche or compatibility cruft; skip in a greenfield schema.
19. The "Live-managed" third definition mode (API-managed, no files) contradicts the rule that files are the source of truth. Don't build it.

**Missing — build these**
20. **True lights-off mode.** Warp refuses to merge, full stop, with no config to change it. Ours: `merge_policy: human | auto_on_green | auto_after_n_approvals` per stage/automation, enforced by *our* orchestrator (merge queue + required checks + revert-on-red), with an audit entry and a global kill switch. This is the differentiator.
21. **Local-first runners as first-class.** Warp says a local-first factory "isn't really a factory" and forbids unmanaged agents as factory hosts. For a solo dev on a Mac that's backwards: a laptop runner with wake-on-demand, resumable sessions, and a queue that survives sleep is the right v1.
22. **Model-agnostic eval harness.** Warp's judges are pinned to its catalog (`model: claude-4-5-haiku`) and judge cost is opaque. Take any OpenAI-compatible endpoint, record judge model + version + prompt hash per score so scores stay comparable, and allow re-scoring a frozen trace corpus with a new judge.
23. **Outbound events / SSE.** No documented way to subscribe to factory state changes — only inbound webhooks and polling `GET /agent/runs`. An append-only JSONL event log per run + SSE/WS fan-out is table stakes for a web UI and for our scorers.
24. **Per-agent tool allowlists, definition round-trip, and cost attribution by stage.** Warp's only levers are secrets + MCP servers + provider permissions, so a reviewer can push; `tools: allow|deny` per agent fixes that. Its managed mode hides its repo and commits for you, so always write files and expose the diff. And cost is per PR/run (children included, split evenly), not per stage or per scorer — we need both so "make review cheaper" is measurable.

---

## Appendix: doc gaps hit

- No benchmark `suite.yaml`/`tasks/*.yaml` in `warp-factory-examples` despite the README promising them; `routers/` likewise has no example file, and `validate_factory_files.py` doesn't submit routers, benchmarks, webhooks, or skills — local validation is partial by design.
- No `Users` page documentation (the reference video's nav has one) and no documented per-factory "Activity"/kanban page, though launch-blog screenshots show Triage/Planning/Building/Reviewing + "Needs attention". Docs cover only `User`/`Editor`/`Admin` roles.
- `factory` / `work_item_stage_changed` is a trigger but its allowed `stages` filter values are never enumerated.
- No outbound event stream or SSE endpoint, and no documented API field names for dashboard metrics (cost/PR, autonomy, cycle time) — UI-only.
- `selfImprovement.failedRunThreshold` is documented as GitHub-backed-only; the Warp-managed equivalent is "server default" and unspecified (blog says "every few hours"/"a schedule you choose", docs say 25 failures or 7 days).
- Azure DevOps `push` and `source_repos` exist in definition files but not in the automation editor.
- Scorer `output` supports only `classification` — no numeric/regression scorers, no code-based scorers, no human-label ingestion.
- Cross-harness benchmarking and production A/B testing are explicitly "not yet supported"; unmanaged self-hosted agents cannot be factory hosts (no laptop/CI-attached runner path).
